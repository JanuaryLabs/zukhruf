# @zukhruf/testing

Disposable fixtures for integration tests on Node.js: Docker containers and database servers, SQLite and DuckDB databases, BigQuery datasets, HTTP servers and controlled streams. Each acquisition returns a handle that `await using` cleans up, also when the test fails. Node's global setup and global teardown remove what a killed test run left behind.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Areas

Each area has its own import path, so a test loads only the drivers it uses. The four drivers are optional peer dependencies: install the one an area names.

| Import                        | Gives                                                  | Needs                      |
| ----------------------------- | ------------------------------------------------------ | -------------------------- |
| `@zukhruf/testing/node`       | Native `test`, `it`, `suite`, `describe` with `.each`  |                            |
| `@zukhruf/testing/async`      | `waitFor`, `timebox`                                   |                            |
| `@zukhruf/testing/process`    | `startWorker`                                          |                            |
| `@zukhruf/testing/docker`     | `DockerTestbed`, `ServiceContainer`, `DockerDirectory` | a Docker engine            |
| `@zukhruf/testing/postgres`   | `Postgres`, `postgresPool`                             | a Docker engine, `pg`      |
| `@zukhruf/testing/mysql`      | `Mysql`, `mysqlPool`                                   | a Docker engine, `mysql2`  |
| `@zukhruf/testing/mariadb`    | `Mariadb`, `mariadbPool`                               | a Docker engine, `mariadb` |
| `@zukhruf/testing/sqlserver`  | `SqlServer`, `SQL_SERVER_FULL_IMAGE`                   | a Docker engine, `mssql`   |
| `@zukhruf/testing/clickhouse` | `ClickHouse`                                           | a Docker engine            |
| `@zukhruf/testing/sqlite`     | `Sqlite`                                               |                            |
| `@zukhruf/testing/duckdb`     | `DuckDB`                                               | `@duckdb/node-api`         |
| `@zukhruf/testing/bigquery`   | `BigQuery`                                             | `@google-cloud/bigquery`   |
| `@zukhruf/testing/http`       | `HttpServer`                                           |                            |
| `@zukhruf/testing/streams`    | `StreamHarness`                                        |                            |
| `@zukhruf/testing/msw`        | `Msw`                                                  | `msw`                      |
| `@zukhruf/testing/preload`    | `notInstalled`                                         |                            |

## Parameterized tests

Import `test` or `it` from `@zukhruf/testing/node` to repeat native test declarations over a table. Use `suite` or `describe` for suites across implementations or configurations.

```ts
import { describe, test } from '@zukhruf/testing/node';

void test.each(
  [
    { name: 'integer', input: '42', expected: 42 },
    { name: 'decimal', input: '1.5', expected: 1.5 },
  ],
  (row) =>
    test(row.name, { timeout: 1_000 }, (t) => {
      t.assert.equal(Number(row.input), row.expected);
    }),
);

void describe.each(['utf8', 'utf16le'] as const, (encoding) =>
  describe(encoding, () => {
    test('round-trips text', (t) => {
      t.assert.equal(
        Buffer.from('hello', encoding).toString(encoding),
        'hello',
      );
    });
  }),
);
```

Both methods accept `(rows, register)`. The rows are a readonly array; scalars, objects, tuples, and factories keep their inferred types. `register(row, index)` must return the native `test()` or `suite()` promise. Names, options, modifiers, and contexts belong to that native call. An empty table or a callback that returns no promise throws during registration.

Call native `test()` or `suite()` directly in the callback in your test file. This preserves Node's declaration location for reports, navigation, and saved-failure reruns. The earlier `(rows, name, [options], body)` prototype registered inside the shared helper and has been removed because those locations collided across files.

Inside an asynchronous parent test, `await test.each(...)` to keep that parent alive until its subtests finish. Call `t.test()` in the registration callback when using the parent's assertion plan. Node controls subtest concurrency through the parent. Inside a suite, native declaration promises fulfill immediately. Acquire and dispose fixtures inside each test body.

These are the original native function objects with an added property: `test === it` and `suite === describe`. Their extended types are available through this import, without globally augmenting `node:test`. This area imports only Node built-ins.

TAP, spec, simultaneous JUnit output, name filtering, skip/TODO reasons, failure exit status, default snapshots, and saved-failure reruns across multiple files are covered by this area's tests. Snapshots belong to the test entry file. Rerun regression tests check actual body execution through persistent failures, a subsequent fix, and replay of the passing results.

## Docker

A `DockerTestbed` acquires containers, volumes and directories on one engine. The `environment` that you give it, such as `process.env`, selects the engine as the Docker CLI does: `DOCKER_HOST`, `DOCKER_CONTEXT`, or the current context in the Docker config directory. The environment also carries the run (see [A killed run](#a-killed-run)). The `@zukhruf/docker` client sends the requests to the Engine API, so no Docker CLI is necessary. The engine is connected on the first acquisition, and every handle keeps that engine. It can be a local Unix socket, the named pipe of Docker Desktop on Windows (`npipe://`), or an SSH engine (`ssh://`).

A test that needs Docker has no skip option. When the engine does not answer, the first acquisition fails with "Docker is required for container-backed tests" and the connection failure as the cause. Start Docker to run these tests.

```ts
import { DockerTestbed } from '@zukhruf/testing/docker';

const testbed = new DockerTestbed({ environment: process.env });

test('a holder in another container', async () => {
  await using volume = await testbed.volume();
  await using holder = await testbed.start({
    Image: 'node:lts-alpine',
    Hostname: 'app',
    Cmd: ['node', '--eval', 'setInterval(() => {}, 1000)'],
    HostConfig: { Binds: [`${volume.name}:/locks`] },
  });
  await holder.kill();
  const { exitCode, stdout } = await testbed.run({
    Image: 'node:lts-alpine',
    Cmd: ['ls', '/locks'],
    HostConfig: { Binds: [`${volume.name}:/locks:ro`] },
  });
});
```

| Member                                           | Gives                                                                                                                                                          | Returns                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `start(body, { name? })`                         | A container this process owns. It stays after it stops, so its logs remain, until disposal removes it.                                                         | `OwnedContainer`                  |
| `serve(body, { internalPort, name?, healthy? })` | A dedicated server whose `internalPort` answers on `127.0.0.1` of this machine. Failure or disposal removes it.                                                | `ServiceContainer`                |
| `reuse(body, { internalPort, name?, healthy? })` | One server per request on the engine, shared across processes, runs and versions of this package.                                                              | `ServiceContainer`                |
| `run(body, { name? })`                           | A container that runs to completion. It gives the output and the exit code, and removes the container. A non-zero exit code does not throw.                    | `ExecResult`                      |
| `volume()`                                       | A named volume.                                                                                                                                                | `OwnedVolume`                     |
| `directory()`                                    | A directory on the engine's host, for bind mounts. It has `mkdir`, `writeFile`, `readFile`, `chmod` and `symlink`.                                             | `DockerDirectory`                 |
| `client()`                                       | The `@zukhruf/docker` client of the engine, for each other Engine API call, such as `info()` or `containers.find(id)`.                                         | `Docker` (from `@zukhruf/docker`) |
| `defaults()`                                     | The run's labels and the default resources, in the shape of a body: `{ Labels, HostConfig: { Memory, NanoCpus } }`. In a run, it holds the run's reaper first. |                                   |

The `body` is the body of a container create in the Engine API: `EngineApi.ContainerCreateRequest` of `@zukhruf/docker`. Write it with the fields of the Engine API, for example `Image`, `Cmd`, `Entrypoint`, `Env` (strings `KEY=value`), `Hostname`, `Labels`, and in `HostConfig`: `Binds`, `Tmpfs`, `Memory`, `NanoCpus`, `IpcMode` and `MemorySwappiness`. The testbed adds these values to each body before it creates the container:

- The run's labels, in `Labels`. A run label replaces a label of the body with the same name. `reuse` does not add the run's labels, because a shared server outlives runs.
- `HostConfig.Memory` of 1 GiB and `HostConfig.NanoCpus` of 1 CPU, when the body does not set them. These limits protect a shared engine from a test container, for example an SSH engine that also runs real applications.
- For `serve` and `reuse`: `internalPort`, published on `127.0.0.1` of the engine's host.

Without `name`, the engine gives the container a name. `reuse` without `name` uses the name `zukhruf-testing-<fingerprint>` (see [Shared servers](#shared-servers)). `healthy` is a function that throws until the server is ready; it runs on every acquisition. Use `timebox` for polling inside it, and pass it the `signal` that `healthy` gets as its second argument: the signal aborts when the container exits first. When the engine does not have the image, the acquisition pulls it, as `docker run` does.

`OwnedContainer`, `OwnedVolume`, `ExecResult` and `Docker` are types of `@zukhruf/docker`. A container has `id`, `exec({ Cmd })`, `logs()`, `kill(signal)` and `inspect()`. `exec` gives `exitCode`, `stdout`, `stderr` and `output`, and it does not throw for a non-zero exit code. The text keeps its last newline. Disposal removes the container with its anonymous volumes.

A `ServiceContainer` has `container`, `host` and `port`. On an SSH engine, the port is a local forward that belongs to the acquiring process. `disconnect()` closes that forward and leaves the container running for its other users. If the forward ended before, for example because the SSH connection died, `disconnect()` rejects with the error of that loss. `cleanup()` and disposal also remove the container of a dedicated server. When the removal fails too, `cleanup()` rejects with a `SuppressedError` that holds both errors. Nothing is written to stderr. A probe in `healthy` gets the `ServiceContainer`: call `container.exec(...)` on it, and do not destructure `exec`.

A server is not ready when `healthy` throws, or when its container exits first. An exit ends the wait at once: the readiness error is "Container … exited with code … before it was ready", with the output of the container. The acquisition attaches to the container before it starts it, so it has this exit code and output also for a container that exits at once. Then `serve` reads the output of the container, removes the container, and rejects. The message of the error has that output. Its `cause` is the readiness error. `reuse` rejects with the readiness error.

### Shared servers

`reuse(body, options)` finds the server for this request, or creates it. The request is the body after the testbed adds its defaults and the published port, and the `internalPort`. The order of the keys and the order of the `Env` entries do not select a different server. Docker reserves the name atomically, so concurrent processes attach to the same container. Different images, passwords, environments or labels select separate servers. The version of `@zukhruf/testing` does not: projects on different versions that send the same request share one server. A readiness failure leaves the shared server running for diagnosis. Dispose a reused server only after all its users finish: disposal stops it for every caller.

The name of a shared server is `zukhruf-testing-<fingerprint>`, and its label `dev.zukhruf.testing.server` holds the fingerprint. The fingerprint is a hash of the request. At the end of a run that used Docker, the run's reaper removes each shared server on its engine that is older than its time to live (TTL) of 7 days, from its `Created` time. It keeps a server while a test process uses it ([ADR 0019](./docs/adr/0019-a-shared-servers-name-comes-from-its-request-and-the-global-teardown-removes-it-after-a-ttl.md)). Each test process that calls `reuse()` holds a process lease for each shared server that it uses: a small `busybox` container that runs `cat` on the input of an attach. When the process exits, also when it is killed, the attach closes and the engine removes the lease. The attach does not keep the process running. Before the reaper removes a server, it takes the sweep lease of that server, and then it looks for a process lease of that server. A test process takes its process lease, and then it looks for the sweep lease of its server. When that sweep lease exists, `reuse()` waits until the sweep ends, and then finds or creates its server ([ADR 0014](./docs/adr/0014-a-test-process-holds-a-process-lease-and-the-global-teardown-keeps-the-shared-servers-of-a-version-that-has-one.md)).

The reaper checks the servers only at the end of a run that used Docker. An engine that no run uses keeps its servers.

When you change your own body, the old server stays until its TTL ends. A newer image behind the same tag does not change the request. To use the newer image now, stop the server:

```sh
docker ps -a --filter label=dev.zukhruf.testing.server
docker stop <container-id>
```

The engine removes a server when it stops, so stopping also removes it.

Versions of this package before ADR 0019 used the label `dev.zukhruf.testing.shared=1`. This version does not see their servers. After each project on that engine uses this version, stop them one time:

```sh
docker ps -a --filter label=dev.zukhruf.testing.shared=1
docker stop <container-id>
```

A shared server starts on the first `database()` call that needs it. When that call is in a test, the time limit of the test also counts the start of the server. Each fixture sets a time limit for the start, its readiness bound: Postgres 60 s, MySQL and MariaDB 90 s, SQL Server 180 s. When the server does not answer in that time, the call fails with "Container … was not ready" and the output of the container. When the container of the server exits first, the call fails at once, with its exit code and output (see [Docker](#docker)). In a run, the first call of a test process that uses the engine also holds the reaper of the run, with a readiness bound of 60 s. When the hold is not ready in that time, the call fails with "The hold of the reaper … was not ready". One test can pay these readiness steps in a row: the hold of the reaper, then the start of a server. Thus the default time limit of `@zukhruf/nx/test` is their sum plus 60 s for the test: the hold 60 s, the slowest server (SQL Server) 180 s and the test 60 s, 300 s (see [the test area](../nx/README.md#what-the-test-target-runs)). When you change a readiness bound, change that default with it.

## A killed run

Disposal cleans up after a test that ends. A test process that is killed (a timeout with `--test-force-exit`, Ctrl-C, an out-of-memory kill) does not dispose its handles. A running container does not stop by itself. Thus Node's global setup and global teardown make the test processes of one `node --test` invocation into one run.

In an Nx workspace with the `test` area of `@zukhruf/nx`, give the project the tag `test:docker`. The plugin adds the global setup of this package and `--test-force-exit` to the `test` target of the project. You do not write a file ([`@zukhruf/nx` test area](../nx/README.md#docker-tests)).

With no Nx plugin, re-export the two functions from one file in your project:

```ts
// src/testing/docker-global-setup.ts
export {
  globalSetup,
  globalTeardown,
} from '@zukhruf/testing/docker-global-setup';
```

Then give the file to `node --test`. The value is a path relative to the working directory. Node does not accept a package name there.

```sh
node --test --test-force-exit --test-global-setup=src/testing/docker-global-setup.ts "src/**/*.test.ts"
```

The global setup sets `ZUKHRUF_TESTING_RUN_ID` and `ZUKHRUF_TESTING_RUN_DIR` for the test processes. A `DockerTestbed` reads them from its `environment` and labels what it creates with the run. In a run, `database()` puts the run's id in the name of each database that it creates on a shared server: `test_<run id>_<16 hex>`.

Before a test process creates anything on an engine, its `DockerTestbed` holds the run's reaper there: a container of the image `docker:28.5.2-cli`, one for each run on each engine ([ADR 0020](./docs/adr/0020-a-reaper-container-removes-a-runs-engine-objects-when-the-attach-that-holds-it-closes-and-recovery-keeps-the-local-records.md)). The reaper mounts a socket of the engine's host, and lets no test process in until it finds itself through that socket. The hold tries `/var/run/docker.sock` first, then the path of the client's socket when the client goes to the engine through a `unix://` host. When no socket goes to the reaper's own engine, the hold fails with the result of each. The first test process creates it. Each test process holds it with one `cat` exec whose connection ends when the process exits, also when it is killed. The hold does not keep the process running. A hold that ends while its process lives, for example at a break of the SSH connection, is taken again at once. About 2 s after the last test process of the run ended, the reaper:

1. removes the labeled containers with their anonymous volumes, and the labeled volumes. It never removes a shared server;
2. removes the run's host directories, which `directory()` makes in the temporary folder of the engine's host: `/tmp` on an SSH engine, else the temporary folder of this machine. It runs `chmod -R u+rwx` first, so a folder that a container made `chmod 000` goes too. On Docker Desktop, a folder that the test process made unreadable with `chmod` stays: no container can open it ([ADR 0023](./docs/adr/0023-the-reaper-removes-the-runs-host-directories.md));
3. drops, on each running shared server of `Postgres`, `Mysql`, `Mariadb` and `SqlServer`, the databases whose name has the run's id, with the client in the server's image ([ADR 0011](./docs/adr/0011-the-run-id-in-a-databases-name-is-its-owner-reference-and-one-collector-for-each-kind-drops-a-dead-runs-databases.md));
4. does steps 1 and 3 again 5 times, 1 s apart, for a create that the engine finished after its test process died;
5. removes each shared server that is older than its TTL, unless a test process holds a process lease for it (see [Shared servers](#shared-servers));
6. removes itself. After its socket check, it has the restart policy `unless-stopped`, so the engine starts it again after a restart of the engine, and it cleans the run with no later test run ([ADR 0022](./docs/adr/0022-a-reaper-starts-again-after-a-restart-of-its-engine-and-removes-itself-at-its-end.md)).

A test process that comes during the 2 s stops the countdown, and the reaper waits for its end. From step 1 on, the reaper is closed: a test process that comes then waits until it removed itself, and holds the next reaper of the run. Each request of the reaper to the engine has a time limit of 10 s, and a removal is tried 10 more times. A shared server that does not answer a list or a drop in that time keeps the run's databases. The test processes and the global teardown never wait for the reaper.

The global teardown is synchronous, because Node does not wait for an asynchronous teardown under `--test-force-exit`, and it makes no engine call. It removes the folder of the run's sockets in `/tmp`, and then the run's records ([ADR 0025](./docs/adr/0025-recovery-and-the-global-teardown-make-no-engine-call-and-a-test-process-has-no-process-record.md)).

If the teardown fails or does not run, for example when the runner is killed, the run's records stay. The next run on the same engine recovers each run whose records stay, from any project of this user. This is recovery. It removes the folder of the run's sockets in `/tmp`, and then the records. It makes no engine call: the run's reaper removes the run's engine objects. Recovery does not touch a run while its runner lives. A reaper that a killed process left `created` is started by the next reaper of another run on the same engine. The records are in `$XDG_STATE_HOME/zukhruf-testing/docker-runs` (`~/.local/state/zukhruf-testing/docker-runs` by default). Do not delete a record to hide a cleanup failure.

The global setup selects the engine as the Docker CLI does, through `@zukhruf/docker`, so the Docker CLI is not necessary. The global setup and the global teardown make no engine call.

On an SSH engine, the global setup holds one SSH connection for the run, through `@zukhruf/ssh` in the runner's process, and serves it to the test processes ([ADR 0024](./docs/adr/0024-a-run-holds-one-ssh-connection-to-an-ssh-engine-and-its-test-processes-reach-the-engine-host-through-it.md)): the engine at `/tmp/zukhruf-testing-<run id>/docker.sock`, which it puts in `DOCKER_HOST`, and a control master beside it for shells and forwards. The folder also keeps the engine's `ssh://` endpoint, so a process finds the run's connection from `DOCKER_HOST` alone, also a child process with the ids of another run. No test process opens an SSH connection or starts an `ssh` process, and a test process that dies closes its channels. A `DockerTestbed` outside a run opens one SSH connection of its own. Run one test file at a time with `--test-concurrency=1` if the engine cannot take more.

Another Docker client can create containers for the run, for example a sandbox launcher. Give it `await testbed.defaults()`: its `Labels` are the run's labels, and its `HostConfig` has the default `Memory` and `NanoCpus`. A client that takes the Engine API body uses them as they are. Map them to the options of a client that has its own options. In a run, `defaults()` holds the run's reaper on the testbed's engine before it gives the labels, as a create does. Thus the reaper removes what the other client created with them after the run's last test process ends. Outside a run, it makes no engine call.

## Databases

`Postgres`, `Mysql`, `Mariadb`, `SqlServer` and `ClickHouse` take the `environment`, such as `process.env`. The environment selects the engine and the run. Each instance makes its own `DockerTestbed` from it. Each `database()` call creates a fresh database on a shared server; disposal drops it. In a run, the name of the database has the run's id. When a test process is killed before its disposal, or a drop in disposal fails, the run's reaper drops the database (see [A killed run](#a-killed-run)). Outside a run, only disposal drops it. `start()` creates a dedicated server; disposal stops it.

```ts
import { Postgres } from '@zukhruf/testing/postgres';

const postgres = new Postgres({ environment: process.env });

test('stores a record', async () => {
  await using database = await postgres.database();
  // database.connectionString. Close your clients before the scope ends.
});
```

The handle has `connectionString`, `host`, `port`, `user`, `password`, `database`, `image` and `containerId`. `Mysql` and `Mariadb` handles also have `query(sql)`. Without an image, `Mysql` runs `mysql:lts` and `Mariadb` runs `mariadb:lts`. MariaDB 11 and later have no `mysql` client, so use `Mariadb` for a MariaDB image. A `Mariadb` connection string starts with `mariadb://`, because the `mariadb` driver accepts no other scheme. Without an image, `SqlServer` runs SQL Server 2022 (`SQL_SERVER_FULL_IMAGE`) on every engine. Microsoft builds it only for amd64, so an ARM engine runs it under emulation. `ClickHouse` takes an explicit `image`, and its `start()` gives a `ServiceContainer` of a dedicated server, so a test can create server-wide users and functions.

`Sqlite` creates a file-backed database in a temporary directory, with a native `DatabaseSync` connection. Disposal closes the connection and removes the directory, including WAL files. `writeLock(path, durationMs)` holds a write lock from another process, which releases it after `durationMs`, even while the caller blocks in a synchronous write.

`DuckDB` creates an in-memory database. Disposal closes the connection before the instance.

`BigQuery` creates a dataset in the project you name. Disposal deletes it with its tables and views. You provide the credentials.

### Take a pool from the database

A handle of `Postgres`, `Mysql` or `Mariadb` gives `pool(options)`, from `database()` and from `start()`. The handle owns the pool: a `pg.Pool`, a `MysqlPool` (a pool of `mysql2/promise`) or a `MariadbPool` (a pool of `mariadb`). The disposal of the handle ends every pool of the handle, and then drops the database ([ADR 0026](./docs/adr/0026-a-database-handle-owns-its-pools-and-its-disposal-ends-them-before-it-drops-the-database.md)). Give the pool to the store under test, not the connection string.

```ts
import { Postgres } from '@zukhruf/testing/postgres';

const postgres = new Postgres({ environment: process.env });

test('counts the items', async (t) => {
  await using database = await postgres.database();
  const pool = database.pool({ max: 2 });
  await pool.query('CREATE TABLE item (id int)');
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM item');
  t.assert.equal(rows[0].n, 0);
});
```

The handle sets the database, the user and the password of the pool. The options are the `pg.PoolConfig` without `connectionString`, `database`, `user` and `password`, so a pool of a handle is always a pool of its database. The options set the rest, for example the size of the pool, the timeouts, or the host and the port.

To send a pool through a proxy, give the host and the port of the proxy in the options. In the example, `proxyTo` is the TCP proxy of the test. Declare the proxy after the database. Its disposal then comes first, and the closed sockets end the clients that wait for an answer:

```ts
await using database = await postgres.database();
await using proxy = await proxyTo({ host: database.host, port: database.port });
const pool = database.pool({ host: proxy.host, port: proxy.port });
```

The disposal of a handle does these steps. `cleanup()` does the same.

1. `pool()` throws from now on.
2. For each pool, at the same time:
   1. It ends the pool, unless the test ended it already. The idle clients close.
   2. It destroys each client that is checked out now.
   3. It waits until the socket of each client has closed: the pool sends `remove` for each client.
3. It drops the database. The disposal of a `start()` handle removes the container.
4. If step 2.2 destroyed a client, the disposal rejects with the number of clients that it destroyed.

The disposal does not wait for a client that is checked out. When the disposal of a handle starts, each scope that the test opened after the handle has closed, because `await using` disposes in reverse order. A client that is still checked out then is a leak: a broken store, or work that the test did not await. Thus a broken store fails at its claim's limit, the test's signal, and its teardown adds no wait.

A test that has no handle, for example one that connects as another role, takes a pool from `postgresPool(config)`. Its disposal does step 2 for its one pool, and rejects when it destroyed a client:

```ts
import { postgresPool } from '@zukhruf/testing/postgres';

await using app = postgresPool({ connectionString: asRole });
await app.pool.query('SELECT 1');
```

A child process or a worker thread cannot take a pool of the handle. Give it `connectionString`, and let its pool end with its process. Declare the handle of the child after the database, so the child ends before the drop.

#### MySQL and MariaDB

The options of a `Mysql` pool are the `mysql.PoolOptions` without `uri`, `database`, `user` and `password`; the options of a `Mariadb` pool are the `PoolConfig` of `mariadb` without `database`, `user` and `password`. A `MysqlPool` has no `end`, no `[Symbol.asyncDispose]` and no callback `pool`, and a `MariadbPool` has no `end` and no `[Symbol.asyncDispose]`: only the disposal of the handle ends the pool, and `await using pool = database.pool()` does not compile. Neither driver tells when a pool is ending, a second `end()` rejects in both, and the `end()` of `mariadb` removes the listeners of the pool and waits up to 10 s for a checked-out connection.

```ts
import { Mysql } from '@zukhruf/testing/mysql';

const mysql = new Mysql({ environment: process.env });

test('counts the items', async (t) => {
  await using database = await mysql.database();
  const pool = database.pool({ connectionLimit: 2 });
  await pool.query('CREATE TABLE item (id int)');
  const [[row]] = await pool.query('SELECT COUNT(*) AS n FROM item');
  t.assert.equal(row.n, 0);
});
```

Step 2 of the disposal differs for each driver:

- `Mysql`: it destroys each connection that is checked out now, then ends the pool, and waits until the server has closed the socket of each connection (`end`). `destroy()` comes first, because an ended pool of mysql2 keeps a destroyed connection and waits behind its running statement. MySQL ends a session that waits in `GET_LOCK` within about 1 s of the client's goodbye, and one in `SLEEP()` within 5 s.
- `Mariadb`: it ends the session of each connection that is checked out now with `KILL CONNECTION`, on a connection of its own, and waits until each of them has seen the server close its socket (`end`). Then it ends the pool, which destroys the socket of each idle connection before it resolves.

A connection that the test destroyed itself is not a leak. A test that has no handle takes a pool from `mysqlPool(options)` or `mariadbPool(config)`, which give `{ pool }` and its disposal, as `postgresPool` does.

Install the driver of the area next to this package: `pg` for `postgres`, `mysql2` for `mysql`, and `mariadb` for `mariadb`. Each is an optional peer dependency. `SqlServer` gets `pool(options)` in the next step of ADR 0026.

## HTTP servers and streams

`new HttpServer().start(handler)` listens on `127.0.0.1` on a free port and resolves once it listens. The handle has `origin` and the native `server`. Disposal closes active connections and waits for the server to close.

The handler is a Node.js request listener. A web framework gives one for its fetch handler: `getRequestListener((request) => app.fetch(request))` from `@hono/node-server`, or `toNodeHandler((request) => auth.handler(request))` from `better-auth/node`. The handler can be async. When it rejects, the rejection stays unhandled and fails the process, as a throw does. The server never answers for a handler that failed. A handler that needs the origin can read a `const` that the test declares after the acquisition: no request arrives before the test gives the origin to a client.

`StreamHarness` gives a controlled producer, `source<T>()`, with `enqueue`, `close`, `error` and a read-only `state`, and a disposable `reader(stream)` that locks a stream without reading ahead. `collectUntilError()` returns the remaining chunks and either `completed` or `errored` with the error.

## Waiting

`waitFor(check, { signal, interval })` calls `check` until it returns without an error, and resolves with its value. `check` can be async. The signal is the limit of the wait: pass `t.signal`, so the test's own timeout ends it, and the test has no number of its own. When the signal aborts, also during a check, the wait stops its timer and rejects with `signal.reason`, with the last error of `check` as its `cause`. The interval is 50 ms by default. The waits run on real time, so a test that moves a fake clock does not move them, and the check can read that clock's timers.

```ts
await waitFor(() => assert.equal(clock.countTimers(), 1), { signal: t.signal });
```

Wait for an event when one exists; `waitFor` is for a fact that only a read shows. Precedent: vitest `vi.waitFor` and Testing Library `waitFor` also retry while the check throws, and keep its last error. They take a timeout; `waitFor` takes a signal. Node's `t.waitFor` takes no signal.

A wait for an event in a test is `untilAborted(promise, t.signal)` of `@zukhruf/async`, and an operation that accepts an `AbortSignal` gets `t.signal`. A test sets no number of its own. `AbortSignal.timeout(ms)` sets one, and `zukhruf/no-own-wait-limit` of `@zukhruf/eslint` reports it in a test, as it reports `t.waitFor`. `t.signal` aborts only when the runner has a test limit, so a direct `node --test` run needs `--test-timeout=<ms>` (the nx test target sets 300000). Then a hung wait ends.

`timebox(fn, options)` retries `fn` until it stops throwing, every 250 ms for at most 30 seconds by default. It takes every p-retry option.

## Worker processes

`startWorker(source, name, { admit, nodeOptions })` runs `source` as an ES module in its own Node process, with `name` as `argv[1]` and an IPC channel back to the test. Disposal kills the worker. The worker also exits when the test process ends, even by SIGKILL, because it reads the end of its stdin. `admit` runs with the child before it can send anything, for example to join it to a coordinator.

The handle records each message whose `type` is a string, in `messages`, and the worker's stderr, in `stderr`. `exit` is how the worker exited, `closed` resolves when it closed. `has(type)` and `find(type)` read the messages so far.

`next(match, { signal })` resolves with the first message that `match` selects, sent before or after the call. It rejects with the worker's stderr when the worker closes first, and with `signal.reason` when the signal aborts. `match` is a type, or a predicate over the message. The predicate sees each message once, in the order the worker sent it, and none after it selected one, so it can count:

```ts
await worker.next('ready', { signal: t.signal });
await worker.next(
  (message) => message.type === 'leader' || message.type === 'follower',
  { signal: t.signal },
);
await worker.next(
  (message) => message.type === 'answer' && message.call === 2,
  { signal: t.signal },
);
let roles = 0;
await worker.next((message) => message.type === 'role' && ++roles === 2, {
  signal: t.signal,
});
```

Precedent: Playwright's `waitForEvent(event, predicate)` and Node's `events.once(emitter, name, { signal })`.

## Temporary directories

A test makes its temporary directory with `TemporaryFiles` of [`@zukhruf/fs`](../fs/README.md#make-a-temporary-directory), the same class that production code uses.

## Environment variables

A test does not change `process.env`. Tests in one file can run at the same time, and `process.env` is one object for the whole process. Thus a value that one test sets is also the value of the other tests. [ADR 0009](./docs/adr/0009-a-test-never-changes-the-environment-of-its-process.md) records this decision.

Give the environment, or the value, to the code under test. `new Postgres({ environment })` takes the environment in this way ([ADR 0007](./docs/adr/0007-a-database-fixture-takes-the-environment.md)). Give a time zone as the `timeZone` of `Intl.DateTimeFormat`. Give a home directory as a parameter. Do not read it from `os.homedir()` in the test.

A child process gets its own environment when it starts. Give the values to the child as `env`:

```ts
import { spawn } from 'node:child_process';

spawn(command, args, { env: { ...process.env, REGION: 'eu-west-1' } });
```

To put a directory first on the `PATH` of a child, join it with `path.delimiter`, which is `:` on Unix and `;` on Windows. Remove an unset `PATH` before the join. On Unix, an empty entry is the current directory:

```ts
import path from 'node:path';

spawn(command, args, {
  env: {
    ...process.env,
    PATH: [binDirectory, process.env.PATH].filter(Boolean).join(path.delimiter),
  },
});
```

## Preloads

A package can have optional peer dependencies. A project that does not use a part of the package does not install the peer of that part. This repository installs each peer. Thus a wrong import of a peer stays green here, and fails only in the project of a consumer.

`notInstalled(...packages)` makes installed packages look not installed, in one child process. Give its result to the `--import` flag of the child, then import your module in the child. The hook changes the resolution of the whole process, and the test process needs the packages. Thus the check runs in a child.

```ts
import spawn from 'nano-spawn';

import { notInstalled } from '@zukhruf/testing/preload';

test('the http area loads without msw', async () => {
  await spawn(process.execPath, [
    '--import',
    notInstalled('msw'),
    '--input-type=module',
    '--eval',
    "await import('@zukhruf/testing/http');",
  ]);
});
```

`notInstalled` returns the URL of a preload: a file of this package that Node.js runs before the entry point of the child. The query of the URL holds the names. The preload adds a `resolve` hook with `registerHooks` of `node:module`. The hook stops each specifier that is a name, or that starts with a name and `/`. Thus `notInstalled('msw')` also stops `msw/node`, and it does not stop `ms`. The hook gives each other specifier to the next hook. It stops a name for each importer, also for an installed package that depends on it: msw requires `ms`, so `notInstalled('ms')` also stops msw.

The hook throws the error that Node.js throws for a package that is not installed:

| Call                  | Error                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------- |
| `import('msw/node')`  | `Cannot find package 'msw' imported from <path of the importer>`, `ERR_MODULE_NOT_FOUND` |
| `require('msw/node')` | `Cannot find module 'msw/node'`, `MODULE_NOT_FOUND`                                      |

Thus code that reads `error.code` to find a peer that is not installed takes the same path as in the project of a consumer. The error of `require` has only the first line of the message of Node.js. It has no require stack, because the hook knows only the importer.

To use more preloads, give one `--import` flag for each. Node.js runs them in order, and each hook gives the specifiers that it does not stop to the hook before it:

```ts
spawn(process.execPath, [
  '--import',
  notInstalled('typescript'),
  '--import',
  notInstalled('@typescript/native'),
  '--import',
  yourOwnPreload,
  entry,
]);
```

In `NODE_OPTIONS`, as `` `--import=${notInstalled('msw')}` ``, the preload also runs in each Node.js process that the child starts with its environment.

A call with no name does not compile. [ADR 0018](./docs/adr/0018-a-preload-is-a-file-of-the-package-and-its-url-gives-its-settings.md) records this design.

## Intercepted requests

`new Msw().intercept(...handlers)` starts an msw server in this process with the handlers, and returns an interception. The handle has `server`, `requests` and `cleanup`. Disposal closes the server.

```ts
import { HttpResponse, http } from 'msw';

import { Msw } from '@zukhruf/testing/msw';

const msw = new Msw();

test('sends the token', async (t) => {
  using interception = msw.intercept(
    http.get('https://api.example.com/user', () =>
      HttpResponse.json({ id: 1 }),
    ),
  );
  await fetchUser('token');
  t.assert.equal(
    interception.requests[0].headers.get('authorization'),
    'Bearer token',
  );
});
```

An interception is always strict: the server listens with `onUnhandledFrame: 'error'`. A request that no handler answers fails: `fetch` rejects, and the cause is the msw error "Cannot bypass a request when using the "error" strategy". msw also prints the method and the URL of the request. There is no option for a different strategy.

`requests` holds a clone of each request that the server receives, in the order of arrival. A clone keeps its body, so the test can read the body after a handler read the original.

`server` is the msw server, of the type `SetupServer` from `msw/node`. Use `interception.server.use(...handlers)` to add handlers for a part of the test.

An interception also receives the requests to a local server, such as an `HttpServer` of the same test. To send them to that server, give a handler for the origin of that server. The handler passes each of its requests through:

```ts
import { http, passthrough } from 'msw';

import { HttpServer } from '@zukhruf/testing/http';

await using local = await new HttpServer().start(handler);
using interception = msw.intercept(
  http.all(`${local.origin}/*`, () => passthrough()),
  http.get('https://api.example.com/user', () => HttpResponse.json({ id: 1 })),
);
```

Do not use a catch-all handler, such as `http.all('*', …)`, that returns nothing for some requests. msw then sends each of those requests to the network, and the strict strategy has no effect. msw 3.0.2 does this.

The driver is msw 3 (`msw ^3.0.3`), which needs Node.js 22.12 or later. Install it next to this package.

## Development

```sh
npx nx run testing:test        # builds, then runs the tests
npx nx run testing:typecheck   # formats, lints, then type checks
```

The tests that need Docker run on every machine, and fail when the engine does not answer. CI runs every test on Linux, where Docker runs Linux containers. The `test` target runs alone (`parallelism: false`): Nx starts no other task while it runs, because its database servers slow down the timing tests of the other projects.
