import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Set by the global setup for the run's test processes: the run's id. */
export const TEST_RUN_ID = 'ZUKHRUF_TESTING_RUN_ID';
/** Set by the global setup for the run's test processes: the run's records. */
export const TEST_RUN_DIRECTORY = 'ZUKHRUF_TESTING_RUN_DIR';
/** The label that ties a container or volume to the run that created it. */
export const TEST_RUN_LABEL = 'dev.zukhruf.testing.run';

/**
 * The records of one `node --test` invocation with the Docker global setup,
 * in the run's directory: the SSH forward directories of this machine, and
 * the SSH commands that use them. While a recorded command lives, the
 * recovery of a later run leaves the run alone.
 */
export class RunRecords {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  /**
   * Writes a process record for `pid`, an SSH command that a test process
   * started. While a recorded process lives, recovery leaves the run alone.
   * Disposing the record forgets a command that ended. The random id keeps
   * a reused pid from deleting the record of the next command that has it.
   */
  async recordProcess(pid: number): Promise<AsyncDisposable> {
    const file = join(this.directory, `process-${pid}-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify({ pid }));
    return { [Symbol.asyncDispose]: () => rm(file, { force: true }) };
  }

  /**
   * Records the directory in /tmp of this machine behind an SSH port forward,
   * which the global teardown removes if this process dies first. Disposing
   * the record forgets the path once the process removed it itself.
   */
  async recordForward(path: string): Promise<AsyncDisposable> {
    const file = join(this.directory, `forward-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify({ path }));
    return { [Symbol.asyncDispose]: () => rm(file, { force: true }) };
  }
}

/**
 * The run this process belongs to: its id marks what the process creates,
 * and its records name the SSH forwards of the process.
 */
export type ProcessRun = { id: string; records: RunRecords };

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
  return { id, records: new RunRecords(directory) };
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

/** The name prefix of the private directory in /tmp behind an SSH port forward. */
export const forwardName = (id: string | undefined): string =>
  `zukhruf-testing-forward-${id ?? 'standalone'}-`;
