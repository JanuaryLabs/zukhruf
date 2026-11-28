import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { aborted, inspect } from 'node:util';

import type { EngineApi } from '@zukhruf/docker';
import { test } from '@zukhruf/parameterized-test';
import { Command, ExitError } from '@zukhruf/process';

import { DockerTestbed, type ServiceContainer } from '../docker/index.ts';
import { Postgres } from './postgres.ts';
import { SqlServer } from './sqlserver.ts';

const docker = new DockerTestbed({ environment: process.env });
/** Removes the servers a test created under its own verification label. */
async function removeScope(scope: string): Promise<void> {
  const client = await docker.client();
  for (const { Id } of await client.containers.list({
    all: true,
    filters: { label: [`dev.zukhruf.testing.verification=${scope}`] },
  }))
    await (await client.containers.find(Id))?.remove({ force: true, v: true });
}

/** Runs `command` in the container `id` and gives its standard output; a non-zero exit code fails. */
async function execIn(id: string, command: string[]): Promise<string> {
  const container = await (await docker.client()).containers.find(id);
  assert.ok(container, `container ${id} exists`);
  const { exitCode, stdout, output } = await container.exec({ Cmd: command });
  assert.equal(exitCode, 0, output);
  return stdout;
}

test('one instance acquires concurrent databases with independent scope cleanup', async () => {
  const scope = randomUUID();
  const postgres = new Postgres({
    environment: process.env,
    labels: { 'dev.zukhruf.testing.verification': scope },
  });
  try {
    const databases = await Promise.all([
      postgres.database(),
      postgres.database(),
    ]);
    const [first, second] = databases;
    const count = async (name: string) =>
      (
        await execIn(first.containerId, [
          'psql',
          '-U',
          first.user,
          '-d',
          'postgres',
          '-Atc',
          `SELECT COUNT(*) FROM pg_database WHERE datname = '${name}'`,
        ])
      ).trimEnd();
    {
      await using outer = first;
      {
        await using inner = second;
        assert.equal(outer.containerId, inner.containerId);
        assert.notEqual(outer.database, inner.database);
        assert.equal(await count(outer.database), '1');
        assert.equal(await count(inner.database), '1');
      }
      assert.equal(await count(first.database), '1');
      assert.equal(await count(second.database), '0');
    }
    assert.equal(await count(first.database), '0');
    await using next = await postgres.database();
    assert.equal(next.containerId, first.containerId);
    assert.notEqual(next.database, first.database);
  } finally {
    await removeScope(scope);
  }
});

test('explicit SQL Server startup creates the requested database and owns cleanup', async () => {
  const database = `owned_${randomUUID().replaceAll('-', '')}`;
  const server = await new SqlServer({
    environment: process.env,
    database,
  }).start();
  const id = server.containerId;
  {
    await using owned = server;
    const { default: sql } = await import('mssql');
    const pool = new sql.ConnectionPool(owned.connectionString);
    try {
      await pool.connect();
      const result = await pool.request().query('SELECT DB_NAME() AS name');
      assert.equal(result.recordset[0].name, database);
    } finally {
      await pool.close();
    }
  }
  // The disposal awaits the forced removal of the container.
  const client = await docker.client();
  assert.equal(await client.containers.find(id), undefined);
});

// A server whose container exits before it answers, as SQL Server 2022 aborts
// with exit code 134 on an engine whose emulation fails it (#4579). The probe
// never passes, so only the exit of the container can end the acquisition.
// A container that exits at once can stop before or after its port is read,
// so its probe may not run. The other container waits on a FIFO until its
// probe writes it, so it exits after its port is read.
void test.each(
  [
    ['shared', 'at once'],
    ['shared', 'after its port is published'],
    ['dedicated', 'at once'],
    ['dedicated', 'after its port is published'],
  ] as const,
  ([acquisition, exit]) =>
    test(`a ${acquisition} server whose container exits ${exit} rejects with the exit code and output of its container`, async (t) => {
      const scope = randomUUID();
      const startup =
        exit === 'at once' ? '' : 'mkfifo /tmp/exit; read -r _ < /tmp/exit; ';
      const body = {
        Image: 'alpine:latest',
        Entrypoint: [
          'sh',
          '-c',
          `${startup}echo "launch_sqlservr.sh: 9 Aborted ${scope}" >&2; exit 134`,
        ],
        Labels: { 'dev.zukhruf.testing.verification': scope },
      };
      const probes: AbortSignal[] = [];
      const options = {
        internalPort: 1433,
        wait: {
          until: async (service: ServiceContainer, signal: AbortSignal) => {
            probes.push(signal);
            if (exit !== 'at once')
              await service.container.exec({
                Cmd: ['sh', '-c', 'echo > /tmp/exit'],
              });
            // The server never answers: only the exit ends the acquisition.
            await aborted(AbortSignal.any([t.signal, signal]), service);
          },
          timeout: 60_000,
        },
      };
      try {
        await assert.rejects(
          acquisition === 'shared'
            ? docker.reuse(body, options)
            : docker.serve(body, options),
          (error: unknown) => {
            const said = inspect(error);
            assert.match(said, /exited with code 134/);
            assert.match(said, new RegExp(`9 Aborted ${scope}`));
            return true;
          },
        );
        assert.ok(probes.every((signal) => signal.aborted));
        if (exit !== 'at once') assert.equal(probes.length, 1);
      } finally {
        await removeScope(scope);
      }
    }),
);

interface DatabaseHandle {
  containerId: string;
  database: string;
  user: string;
  password: string;
  port: number;
}

// Run through the public package in independent Node processes, with no runner
// setup or shared JavaScript module state.
const worker = `
  import assert from 'node:assert/strict';
  import sql from 'mssql';
  import { DockerTestbed } from ${JSON.stringify(new URL('../docker/index.ts', import.meta.url).href)};
  import { Mariadb } from ${JSON.stringify(new URL('./mariadb.ts', import.meta.url).href)};
  import { Mysql } from ${JSON.stringify(new URL('./mysql.ts', import.meta.url).href)};
  import { Postgres } from ${JSON.stringify(new URL('./postgres.ts', import.meta.url).href)};
  import { SqlServer } from ${JSON.stringify(new URL('./sqlserver.ts', import.meta.url).href)};
  const helpers = { Mariadb, Mysql, Postgres, SqlServer };
  const docker = new DockerTestbed({ environment: process.env });
  const { helper, config, fail } = JSON.parse(process.argv[1]);
  let handle;
  try {
    {
      await using container = await new helpers[helper]({ ...config, environment: process.env }).database();
      handle = container;
      if (helper === 'Postgres') {
        const server = await (await docker.client()).containers.find(container.containerId);
        const { exitCode, output } = await server.exec({ Cmd: ['psql',
          '-U', container.user, '-d', container.database, '-v', 'ON_ERROR_STOP=1',
          '-c', 'CREATE TABLE isolated (id INT); INSERT INTO isolated VALUES (1)'] });
        assert.equal(exitCode, 0, output);
      } else if (helper === 'Mysql' || helper === 'Mariadb') {
        assert.deepEqual(await container.query('SHOW TABLES'), []);
        await container.query('CREATE TABLE isolated (id INT)');
        await container.query('INSERT INTO isolated VALUES (1)');
      } else {
        const pool = new sql.ConnectionPool(container.connectionString);
        try {
          await pool.connect();
          await pool.request().query('CREATE TABLE isolated (id INT); INSERT INTO isolated VALUES (1)');
        } finally {
          await pool.close();
        }
      }
      if (fail) throw new Error('intentional scope failure');
    }
    assert.equal(fail, false);
  } catch (error) {
    if (!fail || error.message !== 'intentional scope failure') throw error;
  }
  console.log(JSON.stringify(handle));
`;

void test.each(
  [
    ['postgres', 'Postgres', { user: 'shared_tester' }],
    ['mysql', 'Mysql', {}],
    ['mariadb', 'Mariadb', {}],
    ['sqlserver', 'SqlServer', {}],
  ] as const,
  ([engine, helper, config]) =>
    test(
      `${engine} shares across processes and restarts until explicit cleanup`,
      { timeout: 300_000 },
      async (t) => {
        const scope = randomUUID();
        const labels = { 'dev.zukhruf.testing.verification': scope };
        try {
          const run = async (fail: boolean): Promise<DatabaseHandle> => {
            const worked = await new Command(
              process.execPath,
              [
                '--input-type=module',
                '--eval',
                worker,
                JSON.stringify({
                  helper,
                  config: {
                    ...config,
                    labels,
                    database: `requested_${randomUUID()}`,
                  },
                  fail,
                }),
              ],
              {
                name: 'worker',
                env: { ...process.env, NODE_TEST_CONTEXT: undefined },
                clock: globalThis,
              },
            ).run({ signal: t.signal });
            if (worked.exitCode !== 0) throw new ExitError('worker', worked);
            return JSON.parse(worked.stdout);
          };

          const concurrent = await Promise.allSettled([
            run(false),
            run(false),
            run(false),
          ]);
          const first = concurrent.map((result) => {
            assert.equal(
              result.status,
              'fulfilled',
              result.status === 'rejected' ? String(result.reason) : '',
            );
            return result.value;
          });
          const restarted = await run(false);
          const failed = await run(true);
          const handles = [...first, restarted, failed];
          const [server] = handles;
          assert.ok(server);
          assert.equal(
            new Set(handles.map((handle) => handle.containerId)).size,
            1,
          );
          assert.equal(
            new Set(handles.map((handle) => handle.database)).size,
            handles.length,
          );

          const names = handles
            .map(({ database }) => `'${database}'`)
            .join(',');
          if (engine === 'postgres') {
            const stdout = await execIn(server.containerId, [
              'psql',
              '-U',
              server.user,
              '-d',
              'postgres',
              '-Atc',
              `SELECT COUNT(*) FROM pg_database WHERE datname IN (${names})`,
            ]);
            assert.equal(stdout.trim(), '0');
          } else if (engine === 'mysql' || engine === 'mariadb') {
            const stdout = await execIn(server.containerId, [
              engine,
              `-u${server.user}`,
              `-p${server.password}`,
              '--batch',
              '--skip-column-names',
              '--execute',
              `SELECT COUNT(*) FROM information_schema.schemata WHERE schema_name IN (${names})`,
            ]);
            assert.equal(stdout.trim(), '0');
          } else {
            const { default: sql } = await import('mssql');
            // Worker-local forwarded ports expire with their scope. Acquire a
            // connection in this process to inspect the same persistent server.
            await using inspector = await new SqlServer({
              ...config,
              environment: process.env,
              labels,
            }).database();
            assert.equal(inspector.containerId, server.containerId);
            const pool = new sql.ConnectionPool({
              server: inspector.host,
              port: inspector.port,
              user: server.user,
              password: server.password,
              database: 'master',
              options: { trustServerCertificate: true, encrypt: false },
            });
            try {
              await pool.connect();
              const result = await pool
                .request()
                .query(
                  `SELECT COUNT(*) AS count FROM sys.databases WHERE name IN (${names})`,
                );
              assert.equal(result.recordset[0].count, 0);
            } finally {
              await pool.close();
            }
          }

          const client = await docker.client();
          const shared = await client.containers.find(server.containerId);
          assert.equal((await shared?.inspect())?.State?.Running, true);
          // The engine removes a shared server when it stops.
          const destroyed = await client.watch({
            filters: { container: [server.containerId], event: ['destroy'] },
            signal: t.signal,
          });
          try {
            await shared?.stop();
            await destroyed.find(
              (event: EngineApi.EventMessage) => event.Action === 'destroy',
            );
          } finally {
            destroyed.destroy();
          }
          assert.equal(
            await client.containers.find(server.containerId),
            undefined,
          );
          const replacement = await run(false);
          assert.notEqual(replacement.containerId, server.containerId);
        } finally {
          await removeScope(scope);
        }
      },
    ),
);
