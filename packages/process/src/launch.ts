import type { ChildProcess } from 'node:child_process';
import type { Socket } from 'node:net';
import { Readable, Writable } from 'node:stream';

import { type Options, execa } from 'execa';

import { type Clock, untilAborted } from '@zukhruf/async';

import type { Completed, End, Environment } from './end.ts';
import { errorCode } from './error-code.ts';
import { findFile } from './file.ts';
import { KEEPER, REPORTING_KEEPER, environmentFixes } from './keeper.ts';
import { StartError } from './start-error.ts';
import { Output, StartedProcess } from './started-process.ts';
import { stopGroup } from './stop.ts';

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
  readonly stdout: 'pipe' | 'ignore' | Socket;
  readonly stderr: 'pipe' | 'ignore';
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
  const { subprocess } = await spawnUnderKeeper(target, KEEPER, {
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe', 'pipe'],
    ...(input === undefined ? {} : { input }),
    ipc,
    all: true,
    stripFinalNewline: false,
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
  const { subprocess } = await spawnUnderKeeper(target, REPORTING_KEEPER, {
    stdio: [stdin, stdout, stderr, 'pipe', 'pipe'],
    ipc: channel !== undefined,
    buffer: false,
  });
  const pgid = subprocess.pid;
  const stop = (group: number) =>
    stopGroup(group, subprocess, { grace: target.grace, clock: target.clock });
  const output = new Output(
    subprocess.stdout instanceof Readable ? subprocess.stdout : null,
    subprocess.stderr instanceof Readable ? subprocess.stderr : null,
  );
  try {
    channel?.(subprocess.nodeChildProcess);
  } catch (error) {
    if (pgid !== undefined) await stop(pgid);
    throw error;
  }
  const report = subprocess.stdio[4];
  const pid =
    pgid === undefined || !(report instanceof Readable)
      ? undefined
      : await programPid(report);
  if (pgid === undefined || pid === undefined)
    throw new StartError(`${target.name} could not start`, {
      cause: (await subprocess).cause,
    });
  const started = new StartedProcess(
    {
      pid,
      stdin: subprocess.stdin instanceof Writable ? subprocess.stdin : null,
      output,
    },
    subprocess.then(endFrom),
    { name: target.name, stop: () => stop(pgid) },
  );
  if (signal !== undefined) {
    const stopOnAbort = () => void started.stop();
    signal.addEventListener('abort', stopOnAbort, { once: true });
    void started.ended.then(() =>
      signal.removeEventListener('abort', stopOnAbort),
    );
  }
  if (ready === undefined) {
    // The read of the pid awaited, so the signal can have aborted before its listener.
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
 * Starts the file of the target under `keeper` (ADR 0004): with the
 * environment of the target and nothing else (ADR 0003), detached, so the
 * keeper leads its own process group. The file is found first, or the start
 * rejects with a `StartError` that names the target. `options` give the
 * stdio from fd 3, the lifeline, on, and how execa keeps the output.
 */
async function spawnUnderKeeper<const O extends Options>(
  target: Target,
  keeper: string,
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
  // In an object: a ResultPromise is a thenable, which an async function would await.
  const subprocess = execa(
    '/bin/sh',
    [
      '-c',
      keeper,
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
 * The pid that the reporting keeper writes on fd 4, or undefined when the
 * pipe closes first. The pipe stays flowing, so it ends with the keeper.
 */
function programPid(report: Readable): Promise<number | undefined> {
  const { promise, resolve } = Promise.withResolvers<number | undefined>();
  let text = '';
  report.setEncoding('utf8');
  report.on('data', (chunk: string) => {
    text += chunk;
    const end = text.indexOf('\n');
    if (end !== -1) resolve(Number(text.slice(0, end)));
  });
  report.once('close', () => resolve(undefined));
  return promise;
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
  });
  if (signal?.aborted) throw signal.reason;
  const code = errorCode(result.cause);
  if (result.failed && (code === 'ENOENT' || code === 'EACCES'))
    throw new StartError(`${target.name} could not start`, {
      cause: result.cause,
    });
  return completedFrom(result);
}

/** Stops the group of the keeper at an abort of `signal`. */
function stopOnAbort(
  target: Target,
  pgid: number,
  keeperEnded: Promise<unknown>,
  signal: AbortSignal,
): { promise: Promise<void> } & Disposable {
  const stop = Promise.withResolvers<void>();
  const listener = () => {
    stopGroup(pgid, keeperEnded, {
      grace: target.grace,
      clock: target.clock,
    }).then(stop.resolve, stop.reject);
  };
  signal.addEventListener('abort', listener, { once: true });
  return {
    promise: stop.promise,
    [Symbol.dispose]: () => signal.removeEventListener('abort', listener),
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
