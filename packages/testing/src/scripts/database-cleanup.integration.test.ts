import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Docker } from '@zukhruf/docker';

import type { Database } from '../databases/database.ts';
import { Mariadb } from '../databases/mariadb.ts';
import { Mysql } from '../databases/mysql.ts';
import { Postgres } from '../databases/postgres.ts';
import { SqlServer } from '../databases/sqlserver.ts';
import { TemporaryFiles } from '../fs/temporary-files.ts';

const docker = await Docker.connect({ environment: process.env });
const signals =
  process.platform === 'win32'
    ? 'Windows ends a process on a signal, so it runs no global teardown'
    : false;
const setup = fileURLToPath(
  new URL('./docker-global-setup.ts', import.meta.url),
);
const VERIFICATION = 'dev.zukhruf.testing.verification';

/** A database fixture, and how the test sees a database on its server. */
interface Kind {
  name: string;
  /** The fixture's class, exported from `module`. */
  fixture: string;
  module: string;
  create: (environment: NodeJS.ProcessEnv, scope: string) => Promise<Database>;
  /** Whether `name` is a database on the server of `handle`. */
  exists: (handle: Database, name: string) => Promise<boolean>;
}

const labels = (scope: string) => ({ [VERIFICATION]: scope });

/** Runs `command` in the server of `handle` and gives its standard output. */
async function execIn(handle: Database, command: string[]): Promise<string> {
  const container = await docker.containers.find(handle.containerId);
  assert.ok(container);
  const { exitCode, stdout, output } = await container.exec({ Cmd: command });
  assert.equal(exitCode, 0, output);
  return stdout.trim();
}

const mysqlFamilyExists =
  (client: string) => async (handle: Database, name: string) =>
    (await execIn(handle, [
      client,
      `-u${handle.user}`,
      `-p${handle.password}`,
      '--batch',
      '--skip-column-names',
      '--execute',
      `SELECT COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = '${name}'`,
    ])) === '1';

const kinds: Kind[] = [
  {
    name: 'postgres',
    fixture: 'Postgres',
    module: '../databases/postgres.ts',
    create: (environment, scope) =>
      new Postgres({ environment, labels: labels(scope) }).database(),
    exists: async (handle, name) =>
      (await execIn(handle, [
        'psql',
        '-U',
        handle.user,
        '-d',
        'postgres',
        '-Atc',
        `SELECT COUNT(*) FROM pg_database WHERE datname = '${name}'`,
      ])) === '1',
  },
  {
    name: 'mysql',
    fixture: 'Mysql',
    module: '../databases/mysql.ts',
    create: (environment, scope) =>
      new Mysql({ environment, labels: labels(scope) }).database(),
    exists: mysqlFamilyExists('mysql'),
  },
  {
    name: 'mariadb',
    fixture: 'Mariadb',
    module: '../databases/mariadb.ts',
    create: (environment, scope) =>
      new Mariadb({ environment, labels: labels(scope) }).database(),
    exists: mysqlFamilyExists('mariadb'),
  },
  {
    name: 'sqlserver',
    fixture: 'SqlServer',
    module: '../databases/sqlserver.ts',
    create: (environment, scope) =>
      new SqlServer({ environment, labels: labels(scope) }).database(),
    exists: async (handle, name) => {
      const { default: sql } = await import('mssql');
      const pool = new sql.ConnectionPool(handle.connectionString);
      try {
        await pool.connect();
        const { recordset } = await pool
          .request()
          .input('name', name)
          .query('SELECT COUNT(*) AS n FROM sys.databases WHERE name = @name');
        return recordset[0].n === 1;
      } finally {
        await pool.close();
      }
    },
  },
];

const postgres = kinds[0]!;

/**
 * A test file of a run that takes a database of `kind` on the server of
 * `scope`, writes its name to `statePath`, then runs `ending`.
 */
const workerSource = (
  kind: Kind,
  scope: string,
  statePath: string,
  ending: string,
) => `
  import { test } from 'node:test';
  import { writeFile } from 'node:fs/promises';
  import { ${kind.fixture} } from ${JSON.stringify(new URL(kind.module, import.meta.url).href)};
  test('a database', { timeout: 400000 }, async () => {
    const { database } = await new ${kind.fixture}({ environment: process.env, labels: ${JSON.stringify(labels(scope))} }).database();
    await writeFile(${JSON.stringify(statePath)}, JSON.stringify({ database }));
    ${ending}
  });
`;

/** The environment of a runner that keeps its runs under `state`. */
const runEnvironment = (state: string): Record<string, string | undefined> => ({
  ...process.env,
  XDG_STATE_HOME: state,
  // A runner launched from a test worker would otherwise skip its files.
  NODE_TEST_CONTEXT: undefined,
  // This test runs in a run; the nested run must start its own.
  ZUKHRUF_TESTING_RUN_ID: undefined,
  ZUKHRUF_TESTING_RUN_DIR: undefined,
});

/** Runs `file` with the Docker global setup, and gives its exit code and output. */
async function runFile(file: string, state: string) {
  const child = spawn(
    process.execPath,
    ['--test', `--test-global-setup=${setup}`, '--test-force-exit', file],
    { env: runEnvironment(state), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  child.stdout.on('data', (data) => (output += data));
  child.stderr.on('data', (data) => (output += data));
  const [code]: (number | null)[] = await once(child, 'exit');
  return { code, output };
}

async function readState(
  t: TestContext,
  statePath: string,
): Promise<{ database: string }> {
  await t.waitFor(
    async () => {
      JSON.parse(await readFile(statePath, 'utf8'));
    },
    { timeout: 5_000, interval: 100 },
  );
  return JSON.parse(await readFile(statePath, 'utf8'));
}

/** Removes the servers that a test created under its own verification label. */
async function removeScope(scope: string): Promise<void> {
  for (const { Id } of await docker.containers.list({
    all: true,
    filters: { label: [`${VERIFICATION}=${scope}`] },
  }))
    await (await docker.containers.find(Id))?.remove({ force: true, v: true });
}

for (const kind of kinds) {
  test(
    `a database whose test process was killed is dropped when the run ends (${kind.name})`,
    { skip: signals, timeout: 600_000 },
    async (t) => {
      await using directory = await new TemporaryFiles().directory(
        'zukhruf-testing-database-cleanup-',
      );
      const scope = randomUUID();
      try {
        // The test's own database on the same server: the cleanup of the
        // nested run leaves it.
        await using own = await kind.create(process.env, scope);
        const statePath = join(directory.path, 'state.json');
        const file = join(directory.path, 'worker.test.ts');
        await writeFile(
          file,
          workerSource(
            kind,
            scope,
            statePath,
            "process.kill(process.pid, 'SIGKILL');",
          ),
        );

        const run = await runFile(file, join(directory.path, 'state'));

        assert.notEqual(run.code, 0, run.output);
        assert.doesNotMatch(run.output, /retained ownership record/);
        const { database } = await readState(t, statePath);
        assert.equal(await kind.exists(own, database), false, run.output);
        assert.equal(await kind.exists(own, own.database), true);
      } finally {
        await removeScope(scope);
      }
    },
  );
}

test(
  "the run's cleanup leaves the databases of another run on the same server",
  { skip: signals, timeout: 300_000 },
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-database-cleanup-',
    );
    const scope = randomUUID();
    try {
      await using own = await postgres.create(process.env, scope);
      // A database of another run on the same server.
      await using other = await postgres.create(
        {
          ...process.env,
          ZUKHRUF_TESTING_RUN_ID: randomUUID(),
          ZUKHRUF_TESTING_RUN_DIR: directory.path,
        },
        scope,
      );
      const statePath = join(directory.path, 'state.json');
      const file = join(directory.path, 'worker.test.ts');
      await writeFile(
        file,
        workerSource(
          postgres,
          scope,
          statePath,
          "process.kill(process.pid, 'SIGKILL');",
        ),
      );

      const run = await runFile(file, join(directory.path, 'state'));

      assert.notEqual(run.code, 0, run.output);
      const { database } = await readState(t, statePath);
      assert.equal(await postgres.exists(own, database), false, run.output);
      assert.equal(await postgres.exists(own, other.database), true);
    } finally {
      await removeScope(scope);
    }
  },
);

test(
  'a run whose test process only took a database is cleaned when it ends',
  { timeout: 300_000 },
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-database-cleanup-',
    );
    const scope = randomUUID();
    try {
      await using own = await postgres.create(process.env, scope);
      const statePath = join(directory.path, 'state.json');
      const file = join(directory.path, 'worker.test.ts');
      // The test never disposes its database.
      await writeFile(file, workerSource(postgres, scope, statePath, ''));

      const run = await runFile(file, join(directory.path, 'state'));

      assert.equal(run.code, 0, run.output);
      const { database } = await readState(t, statePath);
      assert.equal(await postgres.exists(own, database), false, run.output);
    } finally {
      await removeScope(scope);
    }
  },
);

test(
  'a run ends cleanly while another process still starts a shared server',
  { skip: signals, timeout: 300_000 },
  async (t) => {
    await using directory = await new TemporaryFiles().directory(
      'zukhruf-testing-database-cleanup-',
    );
    const scope = randomUUID();
    try {
      await using own = await postgres.create(process.env, scope);
      // A MySQL server that does not answer yet: its client is not there.
      const starting = await docker.containers.create({
        Image: 'alpine:latest',
        Cmd: ['sleep', '600'],
        Labels: {
          'dev.zukhruf.testing.shared': '1',
          'dev.zukhruf.testing.kind': 'mysql',
          [VERIFICATION]: scope,
        },
        Env: ['MYSQL_ROOT_PASSWORD=testpassword'],
      });
      await starting.start();
      const statePath = join(directory.path, 'state.json');
      const file = join(directory.path, 'worker.test.ts');
      await writeFile(
        file,
        workerSource(
          postgres,
          scope,
          statePath,
          "process.kill(process.pid, 'SIGKILL');",
        ),
      );

      const run = await runFile(file, join(directory.path, 'state'));

      assert.doesNotMatch(run.output, /retained ownership record/);
      const { database } = await readState(t, statePath);
      assert.equal(await postgres.exists(own, database), false, run.output);
    } finally {
      await removeScope(scope);
    }
  },
);
