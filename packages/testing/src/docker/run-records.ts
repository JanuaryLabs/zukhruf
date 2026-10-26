import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Set by the global setup for the run's test processes: the run's id. */
export const TEST_RUN_ID = 'ZUKHRUF_TESTING_RUN_ID';
/** Set by the global setup for the run's test processes: the run's records. */
export const TEST_RUN_DIRECTORY = 'ZUKHRUF_TESTING_RUN_DIR';
/** The label that ties a container or volume to the run that created it. */
export const TEST_RUN_LABEL = 'dev.zukhruf.testing.run';

/** The run directories that hold a process record of this process. */
const recordedRuns = new Set<string>();

/**
 * The records of one `node --test` invocation with the Docker global setup,
 * in the run's directory. While a recorded process lives, or a record of a
 * path remains, the global teardown, or the recovery of a later run, keeps
 * the run and removes what a killed process left.
 */
export class RunRecords {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  /**
   * Writes a process record for `pid`, a test process or a command it
   * started. While a recorded process lives, the run's records stay.
   * Disposing the record forgets a command that ended. The random id keeps
   * a reused pid from deleting the record of the next command that has it.
   */
  async recordProcess(pid: number): Promise<AsyncDisposable> {
    const file = join(this.directory, `process-${pid}-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify({ pid }));
    return { [Symbol.asyncDispose]: () => rm(file, { force: true }) };
  }

  /**
   * Writes a process record for this process, one time for each run. It is
   * synchronous, so a getter can call it before it gives the run's labels to
   * another Docker client.
   */
  recordThisProcess(): void {
    if (recordedRuns.has(this.directory)) return;
    writeFileSync(
      join(this.directory, `process-${process.pid}-${randomUUID()}.json`),
      JSON.stringify({ pid: process.pid }),
    );
    recordedRuns.add(this.directory);
  }

  /**
   * Writes a creating record while this process asks the engine to create a
   * container. The engine can finish a create after the process that sent it
   * died. While a creating record remains, the global teardown keeps the
   * run's records, and the recovery of a later run sweeps the run again.
   */
  async recordCreating(): Promise<AsyncDisposable> {
    const file = join(this.directory, `creating-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify({ pid: process.pid }));
    return { [Symbol.asyncDispose]: () => rm(file, { force: true }) };
  }

  /**
   * Records a path that the global teardown removes if this process dies first.
   * Disposing the record forgets the path once the process removed it itself.
   */
  async record(
    kind: 'forward' | 'directory',
    path: string,
  ): Promise<AsyncDisposable> {
    const file = join(this.directory, `${kind}-${randomUUID()}.json`);
    await writeFile(file, JSON.stringify({ path }));
    return { [Symbol.asyncDispose]: () => rm(file, { force: true }) };
  }
}

/**
 * The run this process belongs to: its id marks what the process creates,
 * its records keep the run while the process lives.
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

/** The path prefix of the private directory behind an SSH port forward. */
export const forwardPrefix = (id: string | undefined): string =>
  `/tmp/zukhruf-testing-forward-${id ?? 'standalone'}-`;
