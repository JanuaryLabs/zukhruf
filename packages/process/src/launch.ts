import type { ChildProcess } from 'node:child_process';
import { addAbortListener } from 'node:events';
import type { Socket } from 'node:net';
import { Readable, Writable } from 'node:stream';

import { type Options, execa } from 'execa';

import { type Clock, untilAborted } from '@zukhruf/async';

import type { Completed, End, Environment } from './end.ts';
import { errorCode } from './error-code.ts';
import { findFile } from './file.ts';
import { KEEPER, environmentFixes } from './keeper.ts';
import { StartError } from './start-error.ts';
import { Output, StartedProcess } from './started-process.ts';
import { signalGroup, stopGroup } from './stop.ts';

/** What `run()` and `start()` of a command read: the command with its defaults. */
export interface Target {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Environment;
  readonly clock: Clock;
  readonly cwd: string | undefined;
  /** Milliseconds from SIGTERM to SIGKILL: of the keeper and of a stop. */
  readonly grace: number;
  /** Names the process in each error. */
  readonly name: string;
}

export interface Run {
  readonly input: string | Uint8Array | undefined;
  readonly signal: AbortSignal | undefined;
  /** An IPC channel to a Node.js target. */
  readonly ipc: boolean;
}

export interface Launch {
  readonly stdin: 'pipe' | 'ignore' | Socket;
  readonly stdout: 'pipe' | 'ignore' | 'inherit' | Socket;
  readonly stderr: 'pipe' | 'ignore' | 'inherit';
  readonly signal: AbortSignal | undefined;
  /** Resolves when the process is ready; undefined: ready at the start. */
  readonly ready: ((started: StartedProcess) => Promise<void>) | undefined;
  /**
   * Opens an IPC channel to a Node.js target and gets the child in the tick
   * of the spawn, before a message can arrive with no listener.
   */
  readonly channel: ((child: ChildProcess) => void) | undefined;
}

/** Runs the target to its end, and gives its end and its output. */
export async function runUnderKeeper(
  target: Target,
  { input, signal, ipc }: Run,
): Promise<Completed> {
  signal?.throwIfAborted();
  if (process.platform === 'win32')
    return runOnWindows(target, { input, signal, ipc });
  const { subprocess } = await spawnUnderKeeper(target, signal, {
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
    ipc,
    all: true,
    stripFinalNewline: false,
    maxBuffer: Infinity,
  });
  const stopped =
    signal === undefined || subprocess.pid === undefined
      ? undefined
      : stopOnAbort(target, subprocess.pid, subprocess, signal);
  const result = await subprocess;
  if (signal?.aborted) {
    await stopped?.promise;
    throw signal.reason;
  }
  stopped?.[Symbol.dispose]();
  return completedFrom(result);
}

/** Starts the target, and resolves when it is ready (ADR 0006). */
export function startUnderKeeper(
  target: Target,
  launch: Launch & { readonly stdin: 'pipe' },
): Promise<StartedProcess<Writable>>;
export function startUnderKeeper(
  target: Target,
  launch: Launch,
): Promise<StartedProcess>;
export async function startUnderKeeper(
  target: Target,
  { stdin, stdout, stderr, signal, ready, channel }: Launch,
): Promise<StartedProcess> {
  signal?.throwIfAborted();
  const { subprocess } = await spawnUnderKeeper(target, signal, {
    stdio: [stdin, stdout, stderr, 'pipe'],
    ipc: channel !== undefined,
    buffer: false,
  });
  const pid = subprocess.pid;
  if (pid === undefined)
    throw new StartError(`${target.name} could not start`, {
      cause: (await subprocess).cause,
    });
  const stop = () =>
    stopGroup(pid, subprocess, { grace: target.grace, clock: target.clock });
  const output = new Output(
    subprocess.stdout instanceof Readable ? subprocess.stdout : null,
    subprocess.stderr instanceof Readable ? subprocess.stderr : null,
  );
  try {
    channel?.(subprocess.nodeChildProcess);
  } catch (error) {
    await stop();
    throw error;
  }
  const started = new StartedProcess(
    {
      pid,
      stdin: subprocess.stdin instanceof Writable ? subprocess.stdin : null,
      output,
      // Node's own kill: false once Node reaped the program, and no SIGKILL
      // timer, which execa's kill adds after a SIGTERM.
      signal: (name, to) =>
        to === 'group'
          ? signalGroup(pid, name)
          : subprocess.nodeChildProcess.kill(name),
    },
    subprocess.then(endFrom),
    { name: target.name, stop },
  );
  if (signal !== undefined) {
    const onAbort = () => void started.stop();
    signal.addEventListener('abort', onAbort, { once: true });
    void started.ended.then(() => signal.removeEventListener('abort', onAbort));
  }
  if (ready === undefined) {
    // The spawn awaited, so the signal can have aborted before its listener.
    if (signal?.aborted === true) {
      await started.stop();
      throw signal.reason;
    }
    return started;
  }
  try {
    await untilAborted(ready(started), signal);
  } catch (error) {
    await started.stop();
    throw signal?.aborted === true ? signal.reason : error;
  }
  return started;
}

/**
 * Starts the file of the target under the keeper (ADR 0004): with the
 * environment of the target and nothing else (ADR 0003), detached, so the
 * keeper, and the program that it becomes, leads its own process group. The
 * file is found first, or the start rejects with a `StartError` that names
 * the target. An abort of `signal` during that search starts nothing.
 * `options` give the stdio up to fd 3, the lifeline, and how execa keeps the
 * output. The parent closes its end of the lifeline when the program exits,
 * so the watcher of the keeper sees its end and exits.
 */
async function spawnUnderKeeper<const O extends Options>(
  target: Target,
  signal: AbortSignal | undefined,
  options: O,
) {
  const env = definedEnvironment(target.env);
  const cwd = target.cwd ?? process.cwd();
  let path: string;
  try {
    path = await findFile(target.file, env, cwd);
  } catch (cause) {
    throw new StartError(`${target.name} could not start`, { cause });
  }
  signal?.throwIfAborted();
  // In an object: a ResultPromise is a thenable, which an async function would await.
  const subprocess = execa(
    '/bin/sh',
    [
      '-c',
      KEEPER,
      'keeper',
      String(target.grace / 1000),
      '/usr/bin/env',
      ...environmentFixes(env),
      path,
      ...target.args,
    ],
    {
      ...options,
      env,
      extendEnv: false,
      cwd,
      detached: true,
      cleanup: false,
      reject: false,
    },
  );
  subprocess.nodeChildProcess.once('exit', () => {
    subprocess.stdio[3]?.destroy();
  });
  return { subprocess };
}

/** The environment without the names whose value is undefined. */
function definedEnvironment(env: Environment): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/**
 * Windows has no POSIX sh and no process groups, so no keeper: execa starts
 * the file itself (it finds .cmd files and PATHEXT), and stops the process
 * tree with forceKillAfterDelay and killDescendants on its own timers. A
 * start that fails is a spawn error here, so the trial tells it apart
 * (ADR 0002). The process does not end yet with a parent that is killed.
 * Not proven on Windows: backlog #6161.
 */
async function runOnWindows(
  target: Target,
  { input, signal, ipc }: Run,
): Promise<Completed> {
  const result = await execa(target.file, target.args, {
    env: definedEnvironment(target.env),
    extendEnv: false,
    cwd: target.cwd ?? process.cwd(),
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
    ...(signal === undefined ? {} : { cancelSignal: signal }),
    ipc,
    forceKillAfterDelay: target.grace,
    killDescendants: true,
    reject: false,
    all: true,
    stripFinalNewline: false,
    maxBuffer: Infinity,
  });
  if (signal?.aborted) throw signal.reason;
  const code = errorCode(result.cause);
  if (result.failed && (code === 'ENOENT' || code === 'EACCES'))
    throw new StartError(`${target.name} could not start`, {
      cause: result.cause,
    });
  return completedFrom(result);
}

/** Stops the group of the program at an abort of `signal`. */
function stopOnAbort(
  target: Target,
  pgid: number,
  programEnded: Promise<unknown>,
  signal: AbortSignal,
): { promise: Promise<void> } & Disposable {
  const stop = Promise.withResolvers<void>();
  // Also calls the listener when the signal aborted during the spawn.
  const listening = addAbortListener(signal, () => {
    stopGroup(pgid, programEnded, {
      grace: target.grace,
      clock: target.clock,
    }).then(stop.resolve, stop.reject);
  });
  return {
    promise: stop.promise,
    [Symbol.dispose]: () => listening[Symbol.dispose](),
  };
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
