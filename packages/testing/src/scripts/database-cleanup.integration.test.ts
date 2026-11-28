import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, describe } from 'node:test';

import { ContainerNotRunningError } from '@zukhruf/docker';
import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import { Command, type Completed } from '@zukhruf/process';

import { waitFor } from '../async/wait-for.ts';
import type { Database } from '../databases/database.ts';
import { Mariadb } from '../databases/mariadb.ts';
import { Mysql } from '../databases/mysql.ts';
import { Postgres } from '../databases/postgres.ts';
import { SqlServer } from '../databases/sqlserver.ts';
import { engine, proxyless } from '../testing/current-engine.ts';
import { docker } from '../testing/engine-client.ts';
import { EngineProxy } from '../testing/engine-proxy.ts';
import { runEnvironment, runnerArgs } from '../testing/global-setup-run.ts';

const signals =
  process.platform === 'win32'
    ? 'Windows ends a process on a signal, so it runs no global teardown'
    : false;
const VERIFICATION = 'dev.zukhruf.testing.verification';
const DATABASE_LABEL = 'dev.zukhruf.testing.database';

/** The records of the database `database` on the engine. */
const recordsOf = async (database: string): Promise<string[]> =>
  (
    await docker.volumes.list({
      filters: { label: [`${DATABASE_LABEL}=${database}`] },
    })
  ).map(({ Name }) => Name);

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
/** Runs `file` with the Docker global setup, and gives its end and output. */
function runFile(
  file: string,
  env: Record<string, string | undefined>,
): Promise<Completed> {
  return new Command(process.execPath, runnerArgs('--test-force-exit', file), {
    env,
    clock: globalThis,
  }).run();
}

async function readState(
  t: TestContext,
  statePath: string,
): Promise<{ database: string }> {
  return waitFor(async () => JSON.parse(await readFile(statePath, 'utf8')), {
    signal: t.signal,
    interval: 100,
  });
}

/** Removes the servers that a test created under its own verification label. */
async function removeScope(scope: string): Promise<void> {
  for (const { Id } of await docker.containers.list({
    all: true,
    filters: { label: [`${VERIFICATION}=${scope}`] },
  }))
    await (await docker.containers.find(Id))?.remove({ force: true, v: true });
}

// Each test below scopes its servers with a label of its own (VERIFICATION), so each gets servers of its own, and they run four at a time.
describe('the databases of a run', { concurrency: 4 }, () => {
  void test.each(kinds, (kind) =>
    test(
      `a database whose test process was killed is dropped by the reaper after the run ends (${kind.name})`,
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

          const run = await runFile(
            file,
            runEnvironment(join(directory.path, 'state')),
          );

          assert.notEqual(run.exitCode, 0, run.output);
          assert.doesNotMatch(run.output, /retained ownership record/);
          const { database } = await readState(t, statePath);
          // The reaper drops it about 2 s after the run's last test process.
          await waitFor(
            async () =>
              assert.equal(await kind.exists(own, database), false, run.output),
            { signal: t.signal, interval: 200 },
          );
          assert.equal(await kind.exists(own, own.database), true);
        } finally {
          await removeScope(scope);
        }
      },
    ),
  );

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

        const run = await runFile(
          file,
          runEnvironment(join(directory.path, 'state')),
        );

        assert.notEqual(run.exitCode, 0, run.output);
        const { database } = await readState(t, statePath);
        // The reaper drops it about 2 s after the run's last test process.
        await waitFor(
          async () =>
            assert.equal(
              await postgres.exists(own, database),
              false,
              run.output,
            ),
          { signal: t.signal, interval: 200 },
        );
        assert.equal(await postgres.exists(own, other.database), true);
      } finally {
        await removeScope(scope);
      }
    },
  );

  void test.each(kinds, (kind) =>
    test(
      `a disposal drops its database and removes its record (${kind.name})`,
      { timeout: 300_000 },
      async () => {
        const scope = randomUUID();
        try {
          await using own = await kind.create(process.env, scope);
          const handle = await kind.create(process.env, scope);
          assert.equal((await recordsOf(handle.database)).length, 1);

          await handle[Symbol.asyncDispose]();

          assert.deepEqual(await recordsOf(handle.database), []);
          assert.equal(await kind.exists(own, handle.database), false);
        } finally {
          await removeScope(scope);
        }
      },
    ),
  );

  test(
    'a disposal whose drop fails rejects, and keeps the database and its record',
    { timeout: 300_000 },
    async () => {
      const scope = randomUUID();
      try {
        await using own = await postgres.create(process.env, scope);
        const handle = await postgres.create(process.env, scope);
        const server = await docker.containers.find(handle.containerId);
        assert.ok(server);

        // A paused server refuses each exec, and still holds its databases.
        await server.pause();
        try {
          await assert.rejects(
            async () => await handle[Symbol.asyncDispose](),
            ContainerNotRunningError,
          );
        } finally {
          await server.unpause();
        }

        assert.equal((await recordsOf(handle.database)).length, 1);
        assert.equal(await postgres.exists(own, handle.database), true);
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

        const run = await runFile(
          file,
          runEnvironment(join(directory.path, 'state')),
        );

        assert.equal(run.exitCode, 0, run.output);
        const { database } = await readState(t, statePath);
        // The reaper drops it about 2 s after the run's last test process.
        await waitFor(
          async () =>
            assert.equal(
              await postgres.exists(own, database),
              false,
              run.output,
            ),
          { signal: t.signal, interval: 200 },
        );
      } finally {
        await removeScope(scope);
      }
    },
  );
});
