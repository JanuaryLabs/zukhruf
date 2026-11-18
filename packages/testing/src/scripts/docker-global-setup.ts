/**
 * The Docker global setup and teardown for `node --test
 * --test-global-setup=<file>`, where the file re-exports both functions. The
 * setup starts one run: its test processes tie what they create to the run
 * (see readRun), and the teardown removes it after they exit.
 * A run that was killed before it could is removed by a later run on the same
 * engine, from any project of this user.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { Docker } from '@zukhruf/docker';

import { DockerHost } from '../docker/host.ts';
import {
  TEST_RUN_DIRECTORY,
  TEST_RUN_ID,
  readRun,
} from '../docker/run-records.ts';
import { type Run, removeRecordedPaths } from './run-cleanup.ts';

const codeOf = (error: unknown): unknown =>
  Error.isError(error) && 'code' in error ? error.code : undefined;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) !== 'ESRCH';
  }
}

/** The pids in the process records of a run's directory. */
const processes = (directory: string): number[] =>
  readdirSync(directory).flatMap((file) => {
    const pid = /^process-(\d+)-[\da-f-]{36}\.json$/.exec(file)?.[1];
    return pid === undefined ? [] : [Number(pid)];
  });

async function readRunFile(directory: string): Promise<Run | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
  } catch {
    // Its global setup may still be writing it, or another one just claimed it.
    return undefined;
  }
}

/**
 * Removes what dead runs on this engine left on this machine: the recorded
 * SSH forward directories, and then the run's records. It makes no engine
 * call: the reaper of a run removes its engine objects (ADR 0025).
 */
async function recover(root: string, endpoint: string): Promise<void> {
  for (const name of await readdir(root)) {
    // A claim names its runner: while it lives, the run is being recovered.
    const claimant = /^recovering-(\d+)-/.exec(name)?.[1];
    if (claimant !== undefined && alive(Number(claimant))) continue;
    const directory = join(root, name);
    const previous = await readRunFile(directory);
    if (!previous || previous.endpoint !== endpoint || alive(previous.pid))
      continue;
    // A killed runner leaves its test processes running. An SSH command of
    // one can still use a forward directory of the run.
    let pids: number[];
    try {
      pids = processes(directory);
    } catch (error) {
      // Another runner claimed the run between the listing and this read.
      if (codeOf(error) === 'ENOENT') continue;
      throw error;
    }
    if (pids.some(alive)) continue;
    // Runners start in parallel; the rename lets exactly one recover a run.
    const claimed = join(root, `recovering-${process.pid}-${randomUUID()}`);
    try {
      await rename(directory, claimed);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') continue;
      throw error;
    }
    try {
      removeRecordedPaths(previous, claimed);
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
  // The context store names the engine without a call to it.
  const current = (await Docker.contexts({ environment: process.env })).find(
    (context) => context.current,
  );
  if (!current) throw new Error('Docker selects no context');
  // Refuses an engine that the tests do not support.
  const { endpoint } = new DockerHost(current.host, undefined, process.env);
  await recover(root, endpoint);

  const run: Run = { id: randomUUID(), endpoint, pid: process.pid };
  const directory = join(root, run.id);
  await mkdir(directory);
  const pending = join(directory, 'run.pending.json');
  await writeFile(pending, JSON.stringify(run));
  await rename(pending, join(directory, 'run.json'));

  process.env[TEST_RUN_ID] = run.id;
  process.env[TEST_RUN_DIRECTORY] = directory;
  process.env.DOCKER_HOST = endpoint;
  delete process.env.DOCKER_CONTEXT;
}

/**
 * Synchronous: under `--test-force-exit`, Node does not await the global
 * teardown before it exits (internal/test_runner/test, `harness.teardown()`
 * and then `process.exit()`). It makes no engine call: the reaper of the run
 * removes the run's engine objects after its last test process (ADR 0020).
 */
export function globalTeardown(): void {
  const owner = readRun(process.env);
  if (!owner)
    throw new Error(
      `The Docker global teardown runs after its global setup, which sets ${TEST_RUN_ID} and ${TEST_RUN_DIRECTORY}`,
    );
  const { directory } = owner.records;
  try {
    const run: Run = JSON.parse(
      readFileSync(join(directory, 'run.json'), 'utf8'),
    );
    removeRecordedPaths(run, directory);
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    // Node sets exit code 1 for a teardown that throws, but prints nothing.
    console.error(
      `Docker test cleanup failed; retained ownership record for retry: ${directory}`,
      error,
    );
    process.exitCode = 1;
  }
}
