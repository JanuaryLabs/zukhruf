/**
 * The Docker global setup and teardown for `node --test
 * --test-global-setup=<file>`, where the file re-exports both functions. The
 * setup starts one run: its test processes tie what they create to the run
 * (see readRun), and the teardown removes it after they exit.
 * A run that was killed before it could is removed by a later run on the same
 * engine, from any project of this user.
 */
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MessageChannel,
  Worker,
  receiveMessageOnPort,
} from 'node:worker_threads';

import { Docker } from '@zukhruf/docker';

import { DockerHost } from '../docker/host.ts';
import {
  TEST_RUN_DIRECTORY,
  TEST_RUN_ID,
  readRun,
} from '../docker/run-records.ts';
import type { CleanupOutcome, CleanupWork } from './docker-cleanup-worker.ts';
import { ENGINE_CALL_TIMEOUT, type Run, cleanup } from './run-cleanup.ts';

/** How long the global teardown waits for its cleanup worker. */
const CLEANUP_TIMEOUT = 250_000;

const codeOf = (error: unknown): unknown =>
  error instanceof Error && 'code' in error ? error.code : undefined;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return codeOf(error) !== 'ESRCH';
  }
}

/** The records in a run's directory that make its cleanup necessary. */
function records(directory: string): {
  /** The pids in the run's process records. */
  processes: number[];
  /** The number of creates that the engine can still finish. */
  creating: number;
} {
  const files = readdirSync(directory);
  return {
    processes: files.flatMap((file) => {
      const pid = /^process-(\d+)-[\da-f-]{36}\.json$/.exec(file)?.[1];
      return pid === undefined ? [] : [Number(pid)];
    }),
    creating: files.filter((file) => file.startsWith('creating-')).length,
  };
}

/**
 * Whether the engine can still finish a create of the run's directory: one
 * of its creating records is younger than one engine call may take. The
 * process that wrote the record can be dead, as the engine finishes a create
 * that it received.
 */
function createInFlight(directory: string): boolean {
  const since = Date.now() - ENGINE_CALL_TIMEOUT;
  return readdirSync(directory).some(
    (file) =>
      file.startsWith('creating-') &&
      statSync(join(directory, file)).mtimeMs > since,
  );
}

/**
 * The cleanup worker, next to this module: `.ts` when Node runs the source,
 * `.js` when it runs the build.
 */
function cleanupWorker(): URL {
  const extension = extname(fileURLToPath(import.meta.url));
  const url = new URL(`./docker-cleanup-worker${extension}`, import.meta.url);
  if (!existsSync(url))
    throw new Error(
      `The Docker cleanup worker is missing: ${fileURLToPath(url)}`,
    );
  return url;
}

/**
 * Runs the cleanup in a worker and blocks until it ends. Under
 * `--test-force-exit`, Node does not await the global teardown before it
 * exits (internal/test_runner/test, `harness.teardown()` and then
 * `process.exit()`), so the teardown cannot return to the event loop.
 */
function cleanupInWorker(run: Run, directory: string): void {
  const url = cleanupWorker();
  const signal = new SharedArrayBuffer(4);
  const { port1, port2 } = new MessageChannel();
  const work: CleanupWork = { run, directory, port: port2, signal };
  const worker = new Worker(url, {
    execArgv: [],
    workerData: work,
    transferList: [port2],
  });
  worker.unref();
  const waited = Atomics.wait(new Int32Array(signal), 0, 0, CLEANUP_TIMEOUT);
  const received = receiveMessageOnPort(port1);
  port1.close();
  if (waited === 'timed-out' || received === undefined) {
    void worker.terminate();
    throw new Error(
      `The Docker cleanup did not finish within ${CLEANUP_TIMEOUT / 1000} s`,
    );
  }
  const outcome: CleanupOutcome = received.message;
  if ('error' in outcome) {
    const error = new Error(outcome.error.message);
    error.name = outcome.error.name;
    error.stack = outcome.error.detail;
    throw error;
  }
}

async function readRunFile(directory: string): Promise<Run | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
  } catch {
    // Its global setup may still be writing it, or another one just claimed it.
    return undefined;
  }
}

/** Removes what dead runs on this engine left behind. */
async function recover(root: string, endpoint: string): Promise<void> {
  // Connected only when a dead run has something to sweep.
  await using resources = new AsyncDisposableStack();
  let engine: Docker | undefined;
  const connection = async (): Promise<Docker> =>
    (engine ??= resources.use(
      await Docker.connect({
        host: endpoint,
        signal: AbortSignal.timeout(ENGINE_CALL_TIMEOUT),
      }),
    ));
  for (const name of await readdir(root)) {
    // A claim names its runner: while it lives, the run is being recovered.
    const claimant = /^recovering-(\d+)-/.exec(name)?.[1];
    if (claimant !== undefined && alive(Number(claimant))) continue;
    const directory = join(root, name);
    const previous = await readRunFile(directory);
    if (!previous || previous.endpoint !== endpoint || alive(previous.pid))
      continue;
    // A killed runner leaves its test processes running. Each one can still
    // create something.
    let found: ReturnType<typeof records>;
    try {
      found = records(directory);
    } catch (error) {
      // Another runner claimed the run between the listing and this read.
      if (codeOf(error) === 'ENOENT') continue;
      throw error;
    }
    if (found.processes.some(alive)) continue;
    // Runners start in parallel; the rename lets exactly one recover a run.
    const claimed = join(root, `recovering-${process.pid}-${randomUUID()}`);
    try {
      await rename(directory, claimed);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') continue;
      throw error;
    }
    try {
      if (found.processes.length > 0 || found.creating > 0)
        await cleanup(await connection(), previous, claimed);
      // A create that the engine finishes after this sweep is swept by a
      // later recovery, which finds the run again under its own name.
      if (createInFlight(claimed)) await rename(claimed, directory);
      else rmSync(claimed, { recursive: true, force: true });
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
  const { endpoint } = new DockerHost(current.host, undefined);
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

/** Synchronous: see cleanupInWorker. */
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
    const { processes, creating } = records(directory);
    // No test process recorded itself, so the run created nothing.
    if (processes.length > 0 || creating > 0) cleanupInWorker(run, directory);
    // A process that still lives, or a create that the engine can still
    // finish, can still add something: the next run's recovery sweeps again.
    if (!processes.some(alive) && creating === 0)
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
