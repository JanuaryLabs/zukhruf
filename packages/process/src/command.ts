import type { Socket } from 'node:net';
import { Readable, Writable } from 'node:stream';

import { execa } from 'execa';

import { type Clock, untilAborted } from '@zukhruf/async';

import type { Completed, End, Environment } from './end.ts';
import { errorCode } from './error-code.ts';
import { findFile } from './file.ts';
import { KEEPER, environmentFixes } from './keeper.ts';
import { StartError } from './start-error.ts';
import {
  type PipedProcess,
  type Process,
  StartedProcess,
} from './started-process.ts';
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

interface Starting {
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
  readonly #options: CommandOptions;
  /** Milliseconds from SIGTERM to SIGKILL: of the keeper and of a stop. */
  readonly #grace: number;
  /** Names the process in each error: the name, or the file. */
  readonly #name: string;

  constructor(file: string, args: readonly string[], options: CommandOptions) {
    this.file = file;
    this.args = args;
    this.#options = options;
    this.#grace = options.grace ?? 5000;
    this.#name = options.name ?? file;
  }

  /** Runs the command to its end, and gives its end and its output. */
  async run(options: RunOptions = {}): Promise<Completed> {
    const { input, signal } = options;
    signal?.throwIfAborted();
    const env = Object.fromEntries(
      Object.entries(this.#options.env).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const cwd = this.#options.cwd ?? process.cwd();
    if (process.platform === 'win32')
      return this.#runOnWindows(env, cwd, options);
    let path: string;
    try {
      path = await findFile(this.file, env, cwd);
    } catch (cause) {
      throw new StartError(`${this.#name} could not start`, { cause });
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
    return completedFrom(result);
  }

  /** Starts the command, and resolves when it is ready (ADR 0006). */
  start(options?: PipedStartOptions): Promise<PipedProcess>;
  start(options: StartOptions): Promise<Process>;
  async start(options: StartOptions = {}): Promise<Process> {
    const { signal } = options;
    signal?.throwIfAborted();
    // Copied from run(): the start under the keeper (docs/copied-code.md).
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
      throw new StartError(`${this.#name} could not start`, { cause });
    }
    const subprocess = execa(
      '/bin/sh',
      [
        '-c',
        KEEPER,
        'keeper',
        String(this.#grace / 1000),
        '/usr/bin/env',
        ...environmentFixes(env),
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
          options.stdin ?? 'pipe',
          options.stdout ?? 'pipe',
          options.stderr ?? 'pipe',
          'pipe',
        ],
        buffer: false,
        reject: false,
      },
    );
    const pgid = subprocess.pid;
    if (pgid === undefined)
      throw new StartError(`${this.#name} could not start`, {
        cause: (await subprocess).cause,
      });
    const started = new StartedProcess(
      {
        pid: pgid,
        stdin: subprocess.stdin instanceof Writable ? subprocess.stdin : null,
        stdout:
          subprocess.stdout instanceof Readable ? subprocess.stdout : null,
        stderr:
          subprocess.stderr instanceof Readable ? subprocess.stderr : null,
      },
      subprocess.then(endFrom),
      {
        name: this.#name,
        stop: () =>
          stopGroup(pgid, subprocess, {
            grace: this.#grace,
            clock: this.#options.clock,
          }),
      },
    );
    if (signal !== undefined) {
      const stop = () => void started.stop();
      signal.addEventListener('abort', stop, { once: true });
      void started.ended.then(() => signal.removeEventListener('abort', stop));
    }
    if (options.ready === undefined) return started;
    try {
      await untilAborted(started.ready(options.ready.line), signal);
    } catch (error) {
      if (signal?.aborted !== true) throw error;
      await started.stop();
      throw signal.reason;
    }
    return started;
  }

  /**
   * Windows has no POSIX sh and no process groups, so no keeper: execa starts
   * the file itself (it finds .cmd files and PATHEXT), and stops the process
   * tree with forceKillAfterDelay and killDescendants on its own timers. A
   * start that fails is a spawn error here, so the trial tells it apart
   * (ADR 0002). The process does not end yet with a parent that is killed.
   * Not proven on Windows: backlog #6161.
   */
  async #runOnWindows(
    env: Readonly<Record<string, string>>,
    cwd: string,
    { input, signal }: RunOptions,
  ): Promise<Completed> {
    const result = await execa(this.file, this.args, {
      env,
      extendEnv: false,
      cwd,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      ...(input === undefined ? {} : { input }),
      ...(signal === undefined ? {} : { cancelSignal: signal }),
      forceKillAfterDelay: this.#grace,
      killDescendants: true,
      reject: false,
      all: true,
      stripFinalNewline: false,
    });
    if (signal?.aborted) throw signal.reason;
    const code = errorCode(result.cause);
    if (result.failed && (code === 'ENOENT' || code === 'EACCES'))
      throw new StartError(`${this.#name} could not start`, {
        cause: result.cause,
      });
    return completedFrom(result);
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

function completedFrom(result: {
  readonly stdout: string;
  readonly stderr: string;
  readonly all: string;
  readonly exitCode?: number | undefined;
  readonly signal?: NodeJS.Signals | undefined;
}): Completed {
  return {
    ...endFrom(result),
    stdout: result.stdout,
    stderr: result.stderr,
    output: result.all,
  };
}

function endFrom(result: {
  readonly exitCode?: number | undefined;
  readonly signal?: NodeJS.Signals | undefined;
}): End {
  return result.signal === undefined
    ? { exitCode: result.exitCode ?? 0 }
    : { signal: result.signal };
}
