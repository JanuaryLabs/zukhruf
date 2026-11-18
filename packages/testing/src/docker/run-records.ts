import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Set by the global setup for the run's test processes: the run's id. */
export const TEST_RUN_ID = 'ZUKHRUF_TESTING_RUN_ID';
/** Set by the global setup for the run's test processes: the run's records. */
export const TEST_RUN_DIRECTORY = 'ZUKHRUF_TESTING_RUN_DIR';
/** The label that ties a container or volume to the run that created it. */
export const TEST_RUN_LABEL = 'dev.zukhruf.testing.run';

/** What the global setup writes to run.json in the run's directory. */
export interface Run {
  id: string;
  /** The engine of the run, as the context selected it: an ssh:// engine keeps its ssh:// endpoint, although its test processes reach it at the run's docker.sock. */
  endpoint: string;
  pid: number;
}

/** The run this process belongs to: its id marks what the process creates, and its directory holds run.json. */
export type ProcessRun = { id: string; directory: string };

/**
 * The run the global setup started this process in, read from the
 * environment the host passes (`process.env`). Undefined outside a run.
 */
export function readRun(
  environment: Readonly<Record<string, string | undefined>>,
): ProcessRun | undefined {
  const id = environment[TEST_RUN_ID];
  const directory = environment[TEST_RUN_DIRECTORY];
  if (id === undefined && directory === undefined) return undefined;
  if (!id || !directory)
    throw new Error(
      `The global setup sets ${TEST_RUN_ID} and ${TEST_RUN_DIRECTORY} together, but only one of them is set`,
    );
  return { id, directory };
}

/** The name prefix of a host directory that a run's test process created. */
export const directoryPrefix = (id: string | undefined): string =>
  `zukhruf-testing-${id ?? 'standalone'}-`;

/**
 * The folder of the engine's host that holds the host directories: /tmp on
 * the host of an SSH engine, else the temporary folder of this machine. The
 * reaper of a run mounts it and removes the run's directories there.
 */
export const directoryParent = (endpoint: string): string =>
  endpoint.startsWith('ssh://') ? '/tmp' : tmpdir();

/**
 * The folder of the run's SSH connection on an ssh:// engine (ADR 0024): its
 * sockets and the endpoint that they reach. A Unix socket path must fit
 * sun_path (103 characters on macOS), which a path in the run's directory
 * does not, so the folder is in /tmp, as ssh-agent keeps its socket. On
 * Windows, the sockets are named pipes and the folder holds the endpoint.
 */
export const runSocketFolder = (id: string): string =>
  process.platform === 'win32'
    ? join(tmpdir(), `zukhruf-testing-${id}`)
    : `/tmp/zukhruf-testing-${id}`;

/** The files of the run's SSH connection: the Engine API at `docker`, the control master at `master`, and the engine's ssh:// endpoint in `endpoint`. */
export function runSockets(id: string): {
  docker: string;
  master: string;
  endpoint: string;
} {
  const folder = runSocketFolder(id);
  const endpoint = join(folder, 'endpoint');
  if (process.platform === 'win32')
    return {
      docker: `\\\\.\\pipe\\zukhruf-testing-${id}-docker`,
      master: `\\\\.\\pipe\\zukhruf-testing-${id}-ssh`,
      endpoint,
    };
  return {
    docker: join(folder, 'docker.sock'),
    master: join(folder, 'ssh.sock'),
    endpoint,
  };
}

/** The DOCKER_HOST of the test processes of a run on an ssh:// engine: the run's docker.sock. */
export function runDockerHost(id: string): string {
  const { docker } = runSockets(id);
  return process.platform === 'win32'
    ? `npipe://${docker.replaceAll('\\', '/')}`
    : `unix://${docker}`;
}

/**
 * The run's SSH connection that `host` names, when it is the docker.sock of a
 * run on an ssh:// engine: the endpoint that its global setup wrote beside
 * the sockets, and its control master. A process finds the connection from
 * DOCKER_HOST alone, so a child process with the ids of another run still
 * reaches the engine host through it.
 */
export async function servedConnection(
  host: string,
): Promise<{ endpoint: string; master: string } | undefined> {
  const id = /zukhruf-testing-([\da-f-]{36})/.exec(host)?.[1];
  if (id === undefined || host !== runDockerHost(id)) return undefined;
  const { endpoint, master } = runSockets(id);
  return { endpoint: await readFile(endpoint, 'utf8'), master };
}
