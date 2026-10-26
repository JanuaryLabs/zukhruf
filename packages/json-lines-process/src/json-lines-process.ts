import { createInterface } from 'node:readline';

import { type ExecaError, type Options, execa } from 'execa';

import { Latch } from '@zukhruf/async';

// The last part of stderr an exit reports: enough for a native crash, and
// bounded, because a process can write to stderr for hours. execa's maxBuffer
// would end the process instead.
const tail = 16_384;

export interface JsonLinesProcessOptions extends Pick<Options, 'cwd' | 'env'> {
  // Names the process in the error its exit gives, such as "Vision worker".
  readonly name: string;
}

// A long-lived child process that takes JSON values on stdin and gives them
// on stdout, one value per line. What a value means is the caller's
// protocol: one answer per request, or many lines until one says the work is
// done. The exit is an event: exited settles when the process ends, and every
// receive after it fails with the stderr of the process.
export class JsonLinesProcess {
  readonly #name: string;
  readonly #stdin: NodeJS.WritableStream;
  readonly #lines: AsyncIterator<string>;
  readonly #kill: () => void;
  readonly #exit = new Latch<Error>();
  #stderr = '';

  constructor(
    file: string,
    args: readonly string[],
    options: JsonLinesProcessOptions,
  ) {
    const { name, ...spawning } = options;
    this.#name = name;
    // execa's kill sends SIGTERM and, if the process is still alive after
    // five seconds, SIGKILL, as Kubernetes and systemd stop a process: one
    // that shuts down on its own, such as one that saves its state, gets the
    // time.
    const subprocess = execa(file, args, { ...spawning, buffer: false });
    this.#stdin = subprocess.stdin;
    this.#kill = () => subprocess.kill();
    this.#lines = createInterface({ input: subprocess.stdout })[
      Symbol.asyncIterator
    ]();
    subprocess.stderr.on('data', (chunk: Buffer) => {
      this.#stderr = (this.#stderr + chunk.toString()).slice(-tail);
    });
    // A process that failed to start or exited closes stdin under a write;
    // the exit, not the write, tells the caller what happened.
    subprocess.stdin.on('error', () => undefined);
    subprocess.then(
      ({ exitCode }) => this.#exit.open(this.#exited(exitCode)),
      (error: ExecaError) =>
        this.#exit.open(
          error.exitCode === undefined && error.signal === undefined
            ? new Error(`${name} could not start`, { cause: error })
            : this.#exited(error.signal ?? error.exitCode),
        ),
    );
  }

  // Settles with the error that receives get, once the process ended.
  exited(): Promise<Error> {
    return this.#exit.wait();
  }

  send(value: unknown): void {
    this.#stdin.write(`${JSON.stringify(value)}\n`);
  }

  // The next value the process gives. Rejects when the process exits first,
  // or when the line is not JSON.
  async receive(): Promise<unknown> {
    const next = await Promise.race([
      this.#lines.next(),
      this.#exit.wait().then((error) => {
        throw error;
      }),
    ]);
    if (next.done) throw await this.#exit.wait();
    try {
      return JSON.parse(next.value);
    } catch (error) {
      throw new Error(`${this.#name} gave a line that is not JSON`, {
        cause: error,
      });
    }
  }

  // Sends a value and receives the one that answers it.
  request(value: unknown): Promise<unknown> {
    this.send(value);
    return this.receive();
  }

  kill(): void {
    this.#kill();
  }

  // Ends stdin, which asks the process to finish, and waits for its exit.
  async close(): Promise<void> {
    this.#stdin.end();
    await this.#exit.wait();
  }

  #exited(status: number | string | undefined): Error {
    return new Error(
      `${this.#name} exited (${status}): ${this.#stderr.trim()}`,
    );
  }
}
