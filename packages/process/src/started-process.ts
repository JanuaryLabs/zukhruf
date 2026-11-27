import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

import { Latch, Lock } from '@zukhruf/async';

import type { End } from './end.ts';
import { EndedBeforeReadyError } from './ended-before-ready-error.ts';

/** A started process. Only `start()` of a command gives one (ADR 0010). */
export interface Process extends AsyncDisposable {
  readonly name: string;
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

interface Child {
  readonly pid: number;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
}

/**
 * The process behind `Process`. It reads stdout only while someone waits for
 * a line, the ready wait or a reader of `lines()`, and keeps each line it read,
 * so a later reader gets them too.
 */
export class StartedProcess implements Process {
  readonly name: string;
  readonly pid: number;
  readonly stdin: Writable | null;
  readonly #end = new Latch<End>();
  readonly #stop: () => Promise<void>;
  readonly #lines: AsyncIterator<string> | undefined;
  readonly #seen: string[] = [];
  readonly #reading = new Lock();
  #stderr = '';

  constructor(
    child: Child,
    ended: Promise<End>,
    { name, stop }: { name: string; stop: () => Promise<void> },
  ) {
    this.name = name;
    this.pid = child.pid;
    this.stdin = child.stdin;
    void ended.then((end) => this.#end.open(end));
    this.#stop = stop;
    this.#lines = child.stdout
      ? createInterface({ input: child.stdout, crlfDelay: Infinity })[
          Symbol.asyncIterator
        ]()
      : undefined;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.#stderr = (this.#stderr + chunk).slice(-TAIL);
    });
  }

  get ended(): Promise<End> {
    return this.#end.wait();
  }

  async *lines(): AsyncGenerator<string> {
    for (let next = 0; ; next++) {
      const line = this.#seen[next] ?? (await this.#readTo(next));
      if (line === undefined) return;
      yield line;
    }
  }

  /** Resolves at the first line that `line` names; rejects when the process ends first. */
  async ready(line: string | RegExp): Promise<void> {
    const matches =
      typeof line === 'string'
        ? (seen: string) => seen === line
        : (seen: string) => line.test(seen);
    for await (const seen of this.lines()) if (matches(seen)) return;
    throw new EndedBeforeReadyError(this.name, await this.ended, this.#stderr);
  }

  stderrTail(): string {
    return this.#stderr;
  }

  async stop(): Promise<End> {
    await this.#stop();
    return this.ended;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.stop();
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
