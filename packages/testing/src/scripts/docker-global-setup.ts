/**
 * The Docker global setup and teardown for `node --test
 * --test-global-setup=<file>`, where the file re-exports both functions. The
 * setup starts one run: its test processes tie what they create to the run
 * (see readRun), and the teardown removes it after they exit.
 * A run that was killed before it could is removed by a later run on the same
 * engine, from any project of this user.
 */
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { rmSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

import { Docker } from '@zukhruf/docker';
import { OpenSshConfig } from '@zukhruf/ssh/config';
import { ControlMaster } from '@zukhruf/ssh/control';

import { DockerHost, SSH_FLAGS } from '../docker/host.ts';
import {
  type Run,
  TEST_RUN_DIRECTORY,
  TEST_RUN_ID,
  readRun,
  runDockerHost,
  runSocketFolder,
  runSockets,
} from '../docker/run-records.ts';

/** The command that gives the engine of the Docker CLI on the engine host, as @zukhruf/docker finds it (docker ADR 0015). */
const ENGINE_HOST_COMMAND =
  "docker context inspect --format '{{.Endpoints.docker.Host}}'";

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

async function readRunFile(directory: string): Promise<Run | undefined> {
  try {
    return JSON.parse(await readFile(join(directory, 'run.json'), 'utf8'));
  } catch {
    // Its global setup may still be writing it, or another one just claimed it.
    return undefined;
  }
}

/**
 * Removes what dead runs on this engine left on this machine: the folder of
 * the run's sockets, and then the run's records. It makes no engine call: the
 * reaper of a run removes its engine objects (ADR 0025).
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
    // Runners start in parallel; the rename lets exactly one recover a run.
    const claimed = join(root, `recovering-${process.pid}-${randomUUID()}`);
    try {
      await rename(directory, claimed);
    } catch (error) {
      if (codeOf(error) === 'ENOENT') continue;
      throw error;
    }
    try {
      rmSync(runSocketFolder(previous.id), { recursive: true, force: true });
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
  const { endpoint } = new DockerHost(current.host, {
    environment: process.env,
  });
  await recover(root, endpoint);

  const run: Run = { id: randomUUID(), endpoint, pid: process.pid };
  const directory = join(root, run.id);
  await mkdir(directory);
  const pending = join(directory, 'run.pending.json');
  await writeFile(pending, JSON.stringify(run));
  await rename(pending, join(directory, 'run.json'));

  process.env.DOCKER_HOST = endpoint.startsWith('ssh://')
    ? await serveConnection(run, directory)
    : endpoint;
  process.env[TEST_RUN_ID] = run.id;
  process.env[TEST_RUN_DIRECTORY] = directory;
  delete process.env.DOCKER_CONTEXT;
}

/**
 * Serves the SSH connection of a run on an ssh:// engine to its test
 * processes (ADR 0024): a control master at the run's ssh.sock, and the
 * engine at its docker.sock, where each connection is a channel to the
 * engine's socket on the engine host. Resolves with the DOCKER_HOST of the
 * test processes. Nothing of it keeps the runner alive: the end of the runner
 * closes the connection, and the SSH server closes its channels.
 */
async function serveConnection(run: Run, directory: string): Promise<string> {
  const sockets = runSockets(run.id);
  if (process.platform !== 'win32')
    await mkdir(runSocketFolder(run.id), { mode: 0o700 });
  await using stack = new AsyncDisposableStack();
  const config = await OpenSshConfig.resolve(run.endpoint, {
    flags: SSH_FLAGS,
    environment: process.env,
  });
  const client = stack.use(await config.dial({ clock: globalThis }));
  const master = stack.use(await ControlMaster.listen(client, sockets.master));
  const host = new DockerHost(run.endpoint, {
    run: { id: run.id, directory },
  });
  const selected = (await host.shell(ENGINE_HOST_COMMAND)).stdout.trim();
  if (!selected.startsWith('unix://'))
    throw new Error(
      `The Docker CLI on the engine host ${run.endpoint} selects the engine ${JSON.stringify(selected)}; over SSH the tests reach only a unix:// engine`,
    );
  const engineSocket = selected.slice('unix://'.length);
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    socket.on('error', () => socket.destroy());
    void client.dial('unix', engineSocket).then(
      (channel) =>
        Promise.allSettled([
          pipeline(socket, channel),
          pipeline(channel, socket),
        ]),
      () => socket.destroy(),
    );
  });
  server.listen(sockets.docker);
  await once(server, 'listening');
  stack.move();
  server.unref();
  master.unref();
  client.unref();
  return runDockerHost(run.id);
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
  const { id, directory } = owner;
  try {
    rmSync(runSocketFolder(id), { recursive: true, force: true });
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
