#!/usr/bin/env node
/**
 * zukhruf-docker-tests: runs `node --test` with this command's arguments as one
 * supervised run. Its test processes tie what they create to the run (see
 * TestRun.fromEnvironment), and this process removes it after they exit. A
 * run that was killed before it could is removed by the next run on the same
 * engine, from any project of this user.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { SubprocessError } from 'nano-spawn';

import { SHARED_SERVER_LABEL } from '../docker/docker.ts';
import { DockerHost, quote } from '../docker/host.ts';
import {
  TEST_RUN_DIRECTORY,
  TEST_RUN_ID,
  TEST_RUN_LABEL,
  TestRun,
  directoryPrefix,
  forwardPrefix,
} from '../docker/test-run.ts';

interface Run {
  id: string;
  endpoint: string;
  pid: number;
  childPid?: number | undefined;
}

if (process.platform === 'win32')
  throw new Error(
    'zukhruf-docker-tests stops a run as one process group, which Windows does not have',
  );

const root = join(
  process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
  'zukhruf-testing',
  'docker-runs',
);

const codeOf = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined;

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) !== 'ESRCH';
  }
}

/** Ignores Docker's answer that `missing` names something already gone. */
const unlessMissing =
  (missing: RegExp) =>
  (error: unknown): void => {
    if (!(error instanceof SubprocessError) || !missing.test(error.stderr))
      throw error;
  };

async function readRecordedPath(file: string): Promise<string> {
  const { path }: { path: string } = JSON.parse(await readFile(file, 'utf8'));
  return path;
}

async function cleanup(
  host: DockerHost,
  run: Run,
  directory: string,
  release: boolean,
): Promise<void> {
  const owner = new TestRun(run.id, directory);
  // Labels are attached atomically at creation. Never prune a daemon, remove
  // shared servers, or trust names alone as proof of ownership.
  const filter = ['--filter', `label=${TEST_RUN_LABEL}=${run.id}`];
  const { stdout: containers } = await host.command(['ps', '-aq', ...filter]);
  for (const id of containers.split('\n').filter(Boolean)) {
    await host
      .command([
        'inspect',
        '--format',
        `{{index .Config.Labels "${SHARED_SERVER_LABEL}"}}`,
        id,
      ])
      .then(async ({ stdout: shared }) => {
        if (shared !== '1')
          await host.command(['rm', '--force', '--volumes', id]);
      })
      .catch(unlessMissing(/No such (object|container)/i));
  }
  const { stdout: volumes } = await host.command([
    'volume',
    'ls',
    '-q',
    ...filter,
  ]);
  for (const name of volumes.split('\n').filter(Boolean)) {
    await host
      .command(['volume', 'rm', name])
      .catch(unlessMissing(/no such volume|volume \S+ not found/i));
  }
  for (const file of await readdir(directory)) {
    if (file.startsWith('forward-')) {
      const path = await readRecordedPath(join(directory, file));
      if (!path.startsWith(forwardPrefix(owner)) || path.slice(5).includes('/'))
        throw new Error(`Invalid SSH forwarding cleanup record: ${path}`);
      await rm(path, { recursive: true, force: true });
    } else if (file.startsWith('directory-')) {
      const path = await readRecordedPath(join(directory, file));
      if (!path.includes(`/${directoryPrefix(owner)}`) || path.includes('/../'))
        throw new Error(`Invalid fixture cleanup record: ${path}`);
      if (host.remote) await host.shell(`rm -rf -- ${quote(path)}`);
      else await rm(path, { recursive: true, force: true });
    }
  }
  if (release) await rm(directory, { recursive: true, force: true });
}

async function readRun(directory: string): Promise<Run | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
  } catch {
    // Its supervisor may still be writing it, or another one just claimed it.
    return undefined;
  }
}

/** Removes what dead runs on this engine left behind. */
async function recover(host: DockerHost): Promise<void> {
  for (const name of await readdir(root)) {
    // A claim names its supervisor: while it lives, the run is being recovered.
    const claimant = /^recovering-(\d+)-/.exec(name)?.[1];
    if (claimant !== undefined && alive(Number(claimant))) continue;
    const directory = join(root, name);
    const previous = await readRun(directory);
    if (
      !previous ||
      previous.endpoint !== host.endpoint ||
      alive(previous.pid) ||
      alive(previous.childPid) ||
      (previous.childPid !== undefined && alive(-previous.childPid))
    )
      continue;
    // Supervisors start in parallel; the rename lets exactly one recover a run.
    const claimed = join(root, `recovering-${process.pid}-${randomUUID()}`);
    try {
      await rename(directory, claimed);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') continue;
      throw error;
    }
    try {
      await cleanup(host, previous, claimed, true);
    } catch (error) {
      throw new Error(
        `Could not recover Docker test resources. Retained ownership record: ${claimed}`,
        { cause: error },
      );
    }
  }
}

await mkdir(root, { recursive: true });
const host = await DockerHost.resolve();
await recover(host);

const run: Run = {
  id: randomUUID(),
  endpoint: host.endpoint,
  pid: process.pid,
};
const directory = join(root, run.id);
await mkdir(directory);
const record = async (current: Run) => {
  const pending = join(directory, 'run.pending.json');
  await writeFile(pending, JSON.stringify(current));
  await rename(pending, join(directory, 'run.json'));
};
await record(run);

const args = process.argv.slice(2);
const concurrency =
  host.remote && !args.some((arg) => arg.startsWith('--test-concurrency'))
    ? ['--test-concurrency=1']
    : [];
const child = spawn(process.execPath, ['--test', ...concurrency, ...args], {
  stdio: 'inherit',
  detached: true,
  env: {
    ...process.env,
    DOCKER_CONTEXT: undefined,
    DOCKER_HOST: host.endpoint,
    [TEST_RUN_ID]: run.id,
    [TEST_RUN_DIRECTORY]: directory,
  },
});
const exited = new Promise<number>((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code) => resolve(code ?? 1));
});

/** Signals the run's process group; false when the group could not be stopped. */
async function kill(signal: NodeJS.Signals, attempt = 0): Promise<boolean> {
  if (!child.pid) return true;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (codeOf(error) === 'ESRCH') return true;
    // macOS can briefly report EPERM while an empty group is being reaped.
    // Retry that transition; a persistent denial must retain ownership.
    if (codeOf(error) === 'EPERM' && attempt < 3) {
      await delay(25);
      return kill(signal, attempt + 1);
    }
    console.error(
      `Could not signal Docker test process group ${child.pid}:`,
      error,
    );
    child.kill(signal);
    return false;
  }
}

const finished = new AbortController();
const interruption = new AbortController();
const interrupt = () => {
  if (interruption.signal.aborted) return;
  interruption.abort();
  void kill('SIGTERM');
  void delay(5_000, undefined, { signal: finished.signal }).then(
    () => kill('SIGKILL'),
    () => {},
  );
};
process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);
try {
  await record({ ...run, childPid: child.pid });
  const code = await exited;
  process.exitCode = interruption.signal.aborted ? 130 : code;
} finally {
  finished.abort();
  // Includes SSH channels in workers killed by node --test or --test-force-exit.
  const stopped = await kill('SIGKILL');
  try {
    await cleanup(host, run, directory, stopped);
    if (!stopped) {
      process.exitCode = 1;
      console.error(
        `Docker test termination failed; retained ownership record for retry: ${directory}`,
      );
    }
  } catch (error) {
    process.exitCode = 1;
    console.error(
      `Docker test cleanup failed; retained ownership record for retry: ${directory}`,
      error,
    );
  }
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
