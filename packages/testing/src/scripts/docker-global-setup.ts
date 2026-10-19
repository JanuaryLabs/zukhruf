/**
 * The Docker global setup and teardown for `node --test
 * --test-global-setup=<file>`, where the file re-exports both functions. The
 * setup starts one run: its test processes tie what they create to the run
 * (see TestRun.fromEnvironment), and the teardown removes it after they exit.
 * A run that was killed before it could is removed by a later run on the same
 * engine, from any project of this user.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { SHARED_SERVER_LABEL } from '../docker/docker.ts';
import {
  DOCKER_COMMAND_TIMEOUT,
  DockerHost,
  SHELL_TIMEOUT,
  dockerEnvironment,
  quote,
} from '../docker/host.ts';
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
}

const codeOf = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined;

/** What a failed execFileSync call printed: its error carries the output it captured. */
const stderrOf = (error: unknown): string =>
  error instanceof Error && 'stderr' in error ? String(error.stderr) : '';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) !== 'ESRCH';
  }
}

/** Waits without returning to the event loop, which force-exit would end. */
const block = (milliseconds: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
};

/** Ignores Docker's answer that `missing` names something already gone. */
const unlessMissing = (missing: RegExp, error: unknown): void => {
  if (!missing.test(stderrOf(error))) throw error;
};

function readRecordedPath(file: string): string {
  const { path }: { path: string } = JSON.parse(readFileSync(file, 'utf8'));
  return path;
}

/** The pids in the run's process records. */
function recordedProcesses(directory: string): number[] {
  return readdirSync(directory).flatMap((file) => {
    const pid = /^process-(\d+)-[\da-f-]{36}\.json$/.exec(file)?.[1];
    return pid === undefined ? [] : [Number(pid)];
  });
}

/**
 * Removes what carries the run's label and what its records name. It is
 * synchronous: under `--test-force-exit`, Node does not await the global
 * teardown before it exits (internal/test_runner/test, `harness.teardown()`
 * and then `process.exit()`).
 */
function cleanup(host: DockerHost, run: Run, directory: string): void {
  const docker = (args: string[]): string =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      env: { ...process.env, ...dockerEnvironment(host.endpoint) },
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: DOCKER_COMMAND_TIMEOUT,
    }).trim();
  const owner = new TestRun(run.id, directory);
  // Labels are attached atomically at creation. Never prune a daemon, remove
  // shared servers, or trust names alone as proof of ownership.
  const filter = ['--filter', `label=${TEST_RUN_LABEL}=${run.id}`];
  for (const id of docker(['ps', '-aq', ...filter])
    .split('\n')
    .filter(Boolean)) {
    try {
      const shared = docker([
        'inspect',
        '--format',
        `{{index .Config.Labels "${SHARED_SERVER_LABEL}"}}`,
        id,
      ]);
      if (shared !== '1') remove(docker, id);
    } catch (error) {
      unlessMissing(/No such (object|container)/i, error);
    }
  }
  for (const name of docker(['volume', 'ls', '-q', ...filter])
    .split('\n')
    .filter(Boolean)) {
    try {
      docker(['volume', 'rm', name]);
    } catch (error) {
      unlessMissing(/no such volume|volume \S+ not found/i, error);
    }
  }
  for (const file of readdirSync(directory)) {
    if (file.startsWith('forward-')) {
      const path = readRecordedPath(join(directory, file));
      if (!path.startsWith(forwardPrefix(owner)) || path.slice(5).includes('/'))
        throw new Error(`Invalid SSH forwarding cleanup record: ${path}`);
      rmSync(path, { recursive: true, force: true });
    } else if (file.startsWith('directory-')) {
      const path = readRecordedPath(join(directory, file));
      if (!path.includes(`/${directoryPrefix(owner)}`) || path.includes('/../'))
        throw new Error(`Invalid fixture cleanup record: ${path}`);
      if (host.remote)
        execFileSync('ssh', [...host.sshArgs(), `rm -rf -- ${quote(path)}`], {
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: SHELL_TIMEOUT,
        });
      else rmSync(path, { recursive: true, force: true });
    }
  }
}

/**
 * A test process that stops its --rm server as it exits makes Docker refuse
 * this removal until its own one ends; retry until the container is gone.
 */
function remove(docker: (args: string[]) => string, id: string): void {
  const deadline = Date.now() + DOCKER_COMMAND_TIMEOUT;
  for (;;) {
    try {
      docker(['rm', '--force', '--volumes', id]);
      return;
    } catch (error) {
      if (
        Date.now() > deadline ||
        !/removal of container \S+ is already in progress/.test(stderrOf(error))
      )
        throw error;
      block(250);
    }
  }
}

async function readRun(directory: string): Promise<Run | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
  } catch {
    // Its global setup may still be writing it, or another one just claimed it.
    return undefined;
  }
}

/** Removes what dead runs on this engine left behind. */
async function recover(root: string, host: DockerHost): Promise<void> {
  for (const name of await readdir(root)) {
    // A claim names its runner: while it lives, the run is being recovered.
    const claimant = /^recovering-(\d+)-/.exec(name)?.[1];
    if (claimant !== undefined && alive(Number(claimant))) continue;
    const directory = join(root, name);
    const previous = await readRun(directory);
    if (!previous || previous.endpoint !== host.endpoint || alive(previous.pid))
      continue;
    // A killed runner leaves its test processes, and a killed test process
    // its Docker commands, running. Each one can still create something.
    let processes: number[];
    try {
      processes = recordedProcesses(directory);
    } catch (error) {
      // Another runner claimed the run between the listing and this read.
      if (codeOf(error) === 'ENOENT') continue;
      throw error;
    }
    if (processes.some(alive)) continue;
    // Runners start in parallel; the rename lets exactly one recover a run.
    const claimed = join(root, `recovering-${process.pid}-${randomUUID()}`);
    try {
      await rename(directory, claimed);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') continue;
      throw error;
    }
    try {
      if (processes.length > 0) cleanup(host, previous, claimed);
      rmSync(claimed, { recursive: true, force: true });
    } catch (error) {
      throw new Error(
        `Could not recover Docker test resources. Retained ownership record: ${claimed}`,
        { cause: error },
      );
    }
  }
}

export async function globalSetup(): Promise<void> {
  // The XDG Base Directory specification: an unset or empty XDG_STATE_HOME
  // means ~/.local/state.
  const root = join(
    process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'),
    'zukhruf-testing',
    'docker-runs',
  );
  await mkdir(root, { recursive: true });
  const host = await DockerHost.resolve(undefined);
  await recover(root, host);

  const run: Run = {
    id: randomUUID(),
    endpoint: host.endpoint,
    pid: process.pid,
  };
  const directory = join(root, run.id);
  await mkdir(directory);
  const pending = join(directory, 'run.pending.json');
  await writeFile(pending, JSON.stringify(run));
  await rename(pending, join(directory, 'run.json'));

  process.env[TEST_RUN_ID] = run.id;
  process.env[TEST_RUN_DIRECTORY] = directory;
  process.env.DOCKER_HOST = host.endpoint;
  delete process.env.DOCKER_CONTEXT;
}

/** Synchronous, like cleanup, so that `--test-force-exit` cannot cut it off. */
export function globalTeardown(): void {
  const owner = TestRun.fromEnvironment(process.env);
  if (!owner)
    throw new Error(
      `The Docker global teardown runs after its global setup, which sets ${TEST_RUN_ID} and ${TEST_RUN_DIRECTORY}`,
    );
  try {
    const run: Run = JSON.parse(
      readFileSync(join(owner.directory, 'run.json'), 'utf8'),
    );
    const processes = recordedProcesses(owner.directory);
    // No test process recorded itself, so the run created nothing.
    if (processes.length > 0)
      cleanup(new DockerHost(run.endpoint, undefined), run, owner.directory);
    // A process that still lives can still create something: the next run's
    // recovery sweeps again once it has ended.
    if (!processes.some(alive))
      rmSync(owner.directory, { recursive: true, force: true });
  } catch (error) {
    // Node sets exit code 1 for a teardown that throws, but prints nothing.
    console.error(
      `Docker test cleanup failed; retained ownership record for retry: ${owner.directory}`,
      error,
    );
    process.exitCode = 1;
  }
}
