import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Set by the supervisor for the test processes it starts: the run's id. */
export const TEST_RUN_ID = 'ZUKHRUF_TESTING_RUN_ID';
/** Set by the supervisor for the test processes it starts: the run's records. */
export const TEST_RUN_DIRECTORY = 'ZUKHRUF_TESTING_RUN_DIR';
/** The label that ties a container or volume to the run that created it. */
export const TEST_RUN_LABEL = 'dev.zukhruf.testing.run';

/**
 * One supervised `node --test` invocation. What its test processes create
 * carries the run's label or a record in the run's directory, so the
 * supervisor removes it after a process that was killed before it could.
 */
export class TestRun {
  readonly id: string;
  readonly directory: string;

  constructor(id: string, directory: string) {
    this.id = id;
    this.directory = directory;
  }

  /**
   * The run the supervisor started this process in, read from the environment
   * the host passes (`process.env`). Undefined outside a supervisor.
   */
  static fromEnvironment(
    environment: Readonly<Record<string, string | undefined>>,
  ): TestRun | undefined {
    const id = environment[TEST_RUN_ID];
    const directory = environment[TEST_RUN_DIRECTORY];
    if (id === undefined && directory === undefined) return undefined;
    if (!id || !directory)
      throw new Error(
        `The supervisor sets ${TEST_RUN_ID} and ${TEST_RUN_DIRECTORY} together, but only one of them is set`,
      );
    return new TestRun(id, directory);
  }

  get labels(): Record<string, string> {
    return { [TEST_RUN_LABEL]: this.id };
  }

  /**
   * Records a path that the supervisor removes if this process dies first.
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

/** The name prefix of a host directory that a run's test process created. */
export const directoryPrefix = (run: TestRun | undefined): string =>
  `zukhruf-testing-${run?.id ?? 'standalone'}-`;

/** The path prefix of the private directory behind an SSH port forward. */
export const forwardPrefix = (run: TestRun | undefined): string =>
  `/tmp/zukhruf-testing-forward-${run?.id ?? 'standalone'}-`;
