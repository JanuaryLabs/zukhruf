import { Latch } from '@zukhruf/async';

import type { End } from './end.ts';
import { ProcessEndedError } from './process-ended-error.ts';
import type { PipedProcess } from './started-process.ts';

/**
 * The JSON-lines view of a started process (ADR 0007): one JSON value on each
 * line of stdin and of stdout. What a value means is the caller's protocol:
 * one answer for each request, or many lines until one says the work is done.
 */
export class Coprocess implements AsyncDisposable {
  // eslint-disable-next-line zukhruf/no-promise-field -- #6247: the rule reads the `ended` of the interface as a promise kept in a field
  readonly process: PipedProcess;
  readonly #lines: AsyncIterator<string>;
  readonly #ended = new Latch<ProcessEndedError>();

  constructor(process: PipedProcess) {
    this.process = process;
    this.#lines = process.lines()[Symbol.asyncIterator]();
    void process.ended.then((end) =>
      this.#ended.open(
        new ProcessEndedError(
          process.name,
          end,
          process.stderrTail(),
          'it sent a line',
        ),
      ),
    );
  }

  /** Resolves once, when the process has ended, with the error that each later receive rejects with. */
  exited(): Promise<ProcessEndedError> {
    return this.#ended.wait();
  }

  send(value: unknown): void {
    this.process.stdin.write(`${JSON.stringify(value)}\n`);
  }

  /**
   * The next value of stdout. Each line comes before the end, also a line
   * written just before it; after the last line, it rejects with the error
   * that exited() resolves with. A line that is not JSON fails only its own
   * receive.
   */
  async receive(): Promise<unknown> {
    const next = await this.#lines.next();
    if (next.done === true) throw await this.#ended.wait();
    try {
      return JSON.parse(next.value);
    } catch (error) {
      throw new Error(`${this.process.name} gave a line that is not JSON`, {
        cause: error,
      });
    }
  }

  /** Sends a value and receives the one that answers it. */
  request(value: unknown): Promise<unknown> {
    this.send(value);
    return this.receive();
  }

  /** Ends stdin, which asks the process to finish, and resolves with its end. */
  close(): Promise<End> {
    this.process.stdin.end();
    return this.process.ended;
  }

  /** Stops the process group, as the disposal of `process` does. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.process[Symbol.asyncDispose]();
  }
}
