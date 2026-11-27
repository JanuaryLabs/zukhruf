import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { Latch, Lock } from '@zukhruf/async';

import type { End } from './end.ts';
import { ProcessEndedError } from './process-ended-error.ts';

/** A started process. Only `start()` of a command gives one (ADR 0010). */
export interface Process extends AsyncDisposable {
  readonly name: string;
  /** The pid of the program, which leads its process group. */
  readonly pid: number;
  /** null when stdin is 'ignore' or a socket. */
  readonly stdin: Writable | null;
  /** Settles once, with the end. */
  readonly ended: Promise<End>;
  /** The lines of stdout from the first one, also those before the call. */
  lines(): AsyncIterable<string>;
  /** The last 16 384 characters of stderr. */
  stderrTail(): string;
  /** SIGTERM to the group, SIGKILL to the group after the grace. */
  stop(): Promise<End>;
}

/** A started process with its stdin and stdout piped. */
export interface PipedProcess extends Process {
  readonly stdin: Writable;
}

/** The size of the stderr tail (ADR 0006). */
const TAIL = 16 * 1024;

/**
 * The stdout lines and the stderr tail of a child. Build it in the tick of the
 * spawn: when the child exits, Node.js resumes each stdio stream that has no
 * reader yet and drops its data (probed 2026-11-27). It reads stdout only
 * while someone waits for a line, and keeps each line it read, so a later
 * reader gets them too.
 */
export class Output {
  readonly #lines: AsyncIterator<string> | undefined;
  readonly #seen: string[] = [];
  readonly #reading = new Lock();
  #stderr = '';

  constructor(stdout: Readable | null, stderr: Readable | null) {
    this.#lines = stdout
      ? createInterface({ input: stdout, crlfDelay: Infinity })[
          Symbol.asyncIterator
        ]()
      : undefined;
    stderr?.setEncoding('utf8');
    stderr?.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-TAIL);
    });
  }

  async *lines(): AsyncGenerator<string> {
    for (let next = 0; ; next++) {
      const line = this.#seen[next] ?? (await this.#readTo(next));
      if (line === undefined) return;
      yield line;
    }
  }

  stderrTail(): string {
    return this.#stderr;
  }

  /**
   * The line at `index`, undefined at the end of stdout. One reader at a time
   * reads stdout, and a reader that waited finds the line that the reader
   * before it read, so each line is read once and every reader gets it.
   */
  #readTo(index: number): Promise<string | undefined> {
    return this.#reading.run(
      async () => {
        while (this.#seen.length <= index) {
          const next = await this.#lines?.next();
          if (next === undefined || next.done === true) return undefined;
          this.#seen.push(next.value);
        }
        return this.#seen[index];
      },
      { signal: undefined },
    );
  }
}

interface Child<Stdin> {
  readonly pid: number;
  readonly stdin: Stdin;
  readonly output: Output;
}

/** The process behind `Process`; with a `Writable` stdin, it is a `PipedProcess`. */
export class StartedProcess<
  Stdin extends Writable | null = Writable | null,
> implements Process {
  readonly name: string;
  readonly pid: number;
  readonly stdin: Stdin;
  readonly #end = new Latch<End>();
  readonly #stop: () => Promise<void>;
  readonly #output: Output;

  constructor(
    child: Child<Stdin>,
    ended: Promise<End>,
    { name, stop }: { name: string; stop: () => Promise<void> },
  ) {
    this.name = name;
    this.pid = child.pid;
    this.stdin = child.stdin;
    this.#output = child.output;
    void ended.then((end) => this.#end.open(end));
    this.#stop = stop;
  }

  get ended(): Promise<End> {
    return this.#end.wait();
  }

  lines(): AsyncGenerator<string> {
    return this.#output.lines();
  }

  /** Resolves at the first line that `line` names; rejects when the process ends first. */
  async ready(line: string | RegExp): Promise<void> {
    const matches =
      typeof line === 'string'
        ? (seen: string) => seen === line
        : (seen: string) => line.test(seen);
    for await (const seen of this.lines()) if (matches(seen)) return;
    throw new ProcessEndedError(
      this.name,
      await this.ended,
      this.stderrTail(),
      'it was ready',
    );
  }

  stderrTail(): string {
    return this.#output.stderrTail();
  }

  async stop(): Promise<End> {
    await this.#stop();
    return this.ended;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
  }
}
