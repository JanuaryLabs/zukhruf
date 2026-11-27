import type { Socket } from 'node:net';

import type { Clock } from '@zukhruf/async';

import type { Completed, Environment } from './end.ts';
import { type Target, runUnderKeeper, startUnderKeeper } from './launch.ts';
import type { PipedProcess, Process } from './started-process.ts';

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

export interface Starting {
  /** An abort stops the process; before ready, the start rejects with the reason. */
  readonly signal?: AbortSignal;
  readonly stderr?: 'pipe' | 'ignore';
}

/** The default: stdin and stdout piped. Only this start gives a piped process. */
export type PipedStartOptions = Starting & {
  readonly stdin?: 'pipe';
  readonly stdout?: 'pipe';
  /** The first line of stdout that equals the string or matches the expression. */
  readonly ready?: { readonly line: string | RegExp };
};

export type StartOptions =
  | PipedStartOptions
  | (Starting & {
      readonly stdin: 'ignore' | Socket;
      readonly stdout?: 'pipe';
      readonly ready?: { readonly line: string | RegExp };
    })
  | (Starting & {
      readonly stdin?: 'pipe' | 'ignore' | Socket;
      readonly stdout: 'ignore' | Socket;
      readonly ready?: never;
    });

/** What to run. It starts nothing until `run()` or `start()` (ADR 0010). */
export class Command {
  readonly file: string;
  readonly args: readonly string[];
  readonly #target: Target;

  constructor(file: string, args: readonly string[], options: CommandOptions) {
    this.file = file;
    this.args = args;
    this.#target = targetOf(file, args, options);
  }

  /** Runs the command to its end, and gives its end and its output. */
  run({ input, signal }: RunOptions = {}): Promise<Completed> {
    return runUnderKeeper(this.#target, { input, signal, ipc: false });
  }

  /** Starts the command, and resolves when it is ready (ADR 0006). */
  start(options?: PipedStartOptions): Promise<PipedProcess>;
  start(options: StartOptions): Promise<Process>;
  start(options: StartOptions = {}): Promise<Process> {
    const { ready } = options;
    return startUnderKeeper(this.#target, {
      stdin: options.stdin ?? 'pipe',
      stdout: options.stdout ?? 'pipe',
      stderr: options.stderr ?? 'pipe',
      signal: options.signal,
      ready:
        ready === undefined
          ? undefined
          : (started) => started.ready(ready.line),
      channel: undefined,
    });
  }
}

/** The command with its defaults: a grace of 5 seconds, and the file as its name. */
export function targetOf(
  file: string,
  args: readonly string[],
  options: CommandOptions,
): Target {
  return {
    file,
    args,
    env: options.env,
    clock: options.clock,
    cwd: options.cwd,
    grace: options.grace ?? 5000,
    name: options.name ?? file,
  };
}
