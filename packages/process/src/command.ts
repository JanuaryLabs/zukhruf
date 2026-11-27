import { execa } from 'execa';

import type { Clock } from '@zukhruf/async';

import type { Completed, Environment } from './end.ts';
import { findFile } from './file.ts';
import { KEEPER, environmentFixes } from './keeper.ts';
import { StartError } from './start-error.ts';
import { stopGroup } from './stop.ts';

export interface CommandOptions {
  /** The whole environment of the process (ADR 0003). */
  readonly env: Environment;
  /** The clock of each wait, such as the grace (root ADR 0004). An app gives `globalThis`. */
  readonly clock: Clock;
  readonly cwd?: string;
  /** Milliseconds from SIGTERM to SIGKILL. Default 5000. */
  readonly grace?: number;
  /** Names the process in each error. Default: the file. */
  readonly name?: string;
}

export interface RunOptions {
  /** Written to stdin, and then stdin ends. */
  readonly input?: string | Uint8Array;
  /** An abort stops the process and rejects with the reason. */
  readonly signal?: AbortSignal;
}

/** What to run. It starts nothing until `run()` or `start()` (ADR 0010). */
export class Command {
  readonly file: string;
  readonly args: readonly string[];
  readonly #options: CommandOptions;
  /** Milliseconds from SIGTERM to SIGKILL: of the keeper and of a stop. */
  readonly #grace: number;

  constructor(file: string, args: readonly string[], options: CommandOptions) {
    this.file = file;
    this.args = args;
    this.#options = options;
    this.#grace = options.grace ?? 5000;
  }

  /** Runs the command to its end, and gives its end and its output. */
  async run({ input, signal }: RunOptions = {}): Promise<Completed> {
    signal?.throwIfAborted();
    const env = Object.fromEntries(
      Object.entries(this.#options.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const cwd = this.#options.cwd ?? process.cwd();
    let path: string;
    try {
      path = await findFile(this.file, env, cwd);
    } catch (cause) {
      throw new StartError(
        `${this.#options.name ?? this.file} could not start`,
        { cause },
      );
    }
    const fixes = environmentFixes(env);
    const subprocess = execa(
      '/bin/sh',
      [
        '-c',
        KEEPER,
        'keeper',
        String(this.#grace / 1000),
        '/usr/bin/env',
        ...fixes,
        path,
        ...this.args,
      ],
      {
        env,
        extendEnv: false,
        cwd,
        detached: true,
        cleanup: false,
        stdio: [
          input === undefined ? 'ignore' : 'pipe',
          'pipe',
          'pipe',
          'pipe',
        ],
        ...(input === undefined ? {} : { input }),
        reject: false,
        all: true,
        stripFinalNewline: false,
      },
    );
    const stopped =
      signal === undefined || subprocess.pid === undefined
        ? undefined
        : this.#stopOnAbort(subprocess.pid, subprocess, signal);
    const result = await subprocess;
    if (signal?.aborted) {
      await stopped?.promise;
      throw signal.reason;
    }
    stopped?.[Symbol.dispose]();
    const output = {
      stdout: result.stdout,
      stderr: result.stderr,
      output: result.all,
    };
    return result.signal === undefined
      ? { exitCode: result.exitCode ?? 0, ...output }
      : { signal: result.signal, ...output };
  }

  /** Stops the group of the keeper at an abort of `signal`. */
  #stopOnAbort(
    pgid: number,
    keeperEnded: Promise<unknown>,
    signal: AbortSignal,
  ): { promise: Promise<void> } & Disposable {
    const stop = Promise.withResolvers<void>();
    const listener = () => {
      stopGroup(pgid, keeperEnded, {
        grace: this.#grace,
        clock: this.#options.clock,
      }).then(stop.resolve, stop.reject);
    };
    signal.addEventListener('abort', listener, { once: true });
    return {
      promise: stop.promise,
      [Symbol.dispose]: () => signal.removeEventListener('abort', listener),
    };
  }
}
