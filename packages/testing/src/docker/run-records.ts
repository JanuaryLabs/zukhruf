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
 * The folder of the sockets through which the global setup serves the SSH
 * connection of a run on an ssh:// engine (ADR 0024). A Unix socket path must
 * fit sun_path (103 characters on macOS), which a path in the run's directory
 * does not, so the folder is in /tmp, as ssh-agent keeps its socket.
 */
export const runSocketFolder = (id: string): string =>
  `/tmp/zukhruf-testing-${id}`;

/** The sockets of the run's SSH connection: the Engine API at `docker` and the control master at `master`. Named pipes on Windows. */
export function runSockets(id: string): { docker: string; master: string } {
  if (process.platform === 'win32')
    return {
      docker: `\\\\.\\pipe\\zukhruf-testing-${id}-docker`,
      master: `\\\\.\\pipe\\zukhruf-testing-${id}-ssh`,
    };
  const folder = runSocketFolder(id);
  return {
    docker: join(folder, 'docker.sock'),
    master: join(folder, 'ssh.sock'),
  };
}

/** The DOCKER_HOST of the test processes of a run on an ssh:// engine: the run's docker.sock. */
export function runDockerHost(id: string): string {
  const { docker } = runSockets(id);
  return process.platform === 'win32'
    ? `npipe://${docker.replaceAll('\\', '/')}`
    : `unix://${docker}`;
}
