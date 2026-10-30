# @zukhruf/testing

Disposable fixtures for integration tests on Node.js: Docker containers and database servers, SQLite and DuckDB databases, BigQuery datasets, HTTP servers and controlled streams. Each acquisition returns a handle that `await using` cleans up, also when the test fails. Node's global setup and global teardown remove what a killed test run left behind.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Areas

Each area has its own import path, so a test loads only the drivers it uses. The four drivers are optional peer dependencies: install the one an area names.

| Import                        | Gives                                                         | Needs                    |
| ----------------------------- | ------------------------------------------------------------- | ------------------------ |
| `@zukhruf/testing/node`       | Native `test`, `it`, `suite`, `describe` with `.each`         |                          |
| `@zukhruf/testing/async`      | `timebox`, `settleWithin`                                     |                          |
| `@zukhruf/testing/docker`     | `DockerTestbed`, `ServiceContainer`, `DockerDirectory`        | a Docker engine          |
| `@zukhruf/testing/postgres`   | `Postgres`                                                    | a Docker engine          |
| `@zukhruf/testing/mysql`      | `Mysql`                                                       | a Docker engine          |
| `@zukhruf/testing/mariadb`    | `Mariadb`                                                     | a Docker engine          |
| `@zukhruf/testing/sqlserver`  | `SqlServer`, `SQL_SERVER_FULL_IMAGE`, `SQL_SERVER_EDGE_IMAGE` | a Docker engine, `mssql` |
| `@zukhruf/testing/clickhouse` | `ClickHouse`                                                  | a Docker engine          |
| `@zukhruf/testing/sqlite`     | `Sqlite`                                                      |                          |
| `@zukhruf/testing/duckdb`     | `DuckDB`                                                      | `@duckdb/node-api`       |
| `@zukhruf/testing/bigquery`   | `BigQuery`                                                    | `@google-cloud/bigquery` |
| `@zukhruf/testing/http`       | `HttpServer`                                                  |                          |
| `@zukhruf/testing/streams`    | `StreamHarness`                                               |                          |
| `@zukhruf/testing/fs`         | `TemporaryFiles`                                              |                          |
| `@zukhruf/testing/msw`        | `Msw`                                                         | `msw`                    |

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

| Member                                           | Gives                                                                                                                                       | Returns                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `start(body, { name? })`                         | A container this process owns. It stays after it stops, so its logs remain, until disposal removes it.                                      | `OwnedContainer`                  |
| `serve(body, { internalPort, name?, healthy? })` | A dedicated server whose `internalPort` answers on `127.0.0.1` of this machine. Failure or disposal removes it.                             | `ServiceContainer`                |
| `reuse(body, { internalPort, name?, healthy? })` | One server per configuration and package version on the engine, shared across processes and runs.                                           | `ServiceContainer`                |
| `run(body, { name? })`                           | A container that runs to completion. It gives the output and the exit code, and removes the container. A non-zero exit code does not throw. | `ExecResult`                      |
| `volume()`                                       | A named volume.                                                                                                                             | `OwnedVolume`                     |
| `directory()`                                    | A directory on the engine's host, for bind mounts. It has `mkdir`, `writeFile`, `readFile`, `chmod` and `symlink`.                          | `DockerDirectory`                 |
| `client()`                                       | The `@zukhruf/docker` client of the engine, for each other Engine API call, such as `info()` or `containers.find(id)`.                      | `Docker` (from `@zukhruf/docker`) |
| `defaults`                                       | The run's labels and the default resources, in the shape of a body: `{ Labels, HostConfig: { Memory, NanoCpus } }`.                         |                                   |

The `body` is the body of a container create in the Engine API: `EngineApi.ContainerCreateRequest` of `@zukhruf/docker`. Write it with the fields of the Engine API, for example `Image`, `Cmd`, `Entrypoint`, `Env` (strings `KEY=value`), `Hostname`, `Labels`, and in `HostConfig`: `Binds`, `Tmpfs`, `Memory`, `NanoCpus`, `IpcMode` and `MemorySwappiness`. The testbed adds these values to each body before it creates the container:

- The run's labels, in `Labels`. A run label replaces a label of the body with the same name. `reuse` does not add the run's labels, because a shared server outlives runs.
- `HostConfig.Memory` of 1 GiB and `HostConfig.NanoCpus` of 1 CPU, when the body does not set them. These limits protect a shared engine from a test container, for example an SSH engine that also runs real applications.
- For `serve` and `reuse`: `internalPort`, published on `127.0.0.1` of the engine's host.

Without `name`, the engine gives the container a name. `reuse` without `name` uses the name `zukhruf-testing-<fingerprint>` (see [Shared servers](#shared-servers)). `healthy` is a function that throws until the server is ready; it runs on every acquisition. Use `timebox` for polling inside it. When the engine does not have the image, the acquisition pulls it, as `docker run` does.

`OwnedContainer`, `OwnedVolume`, `ExecResult` and `Docker` are types of `@zukhruf/docker`. A container has `id`, `exec({ Cmd })`, `logs()`, `kill(signal)` and `inspect()`. `exec` gives `exitCode`, `stdout`, `stderr` and `output`, and it does not throw for a non-zero exit code. The text keeps its last newline. Disposal removes the container with its anonymous volumes.

A `ServiceContainer` has `container`, `host` and `port`. On an SSH engine, the port is a local forward that belongs to the acquiring process. `disconnect()` closes that forward and leaves the container running for its other users. If the forward ended before, for example because the SSH connection died, `disconnect()` rejects with what ssh printed. `cleanup()` and disposal also remove the container of a dedicated server. When the removal fails too, `cleanup()` rejects with a `SuppressedError` that holds both errors. Nothing is written to stderr. A probe in `healthy` gets the `ServiceContainer`: call `container.exec(...)` on it, and do not destructure `exec`.

A dedicated server is not ready when `healthy` throws, or when its container exits first. Then `serve` reads the output of the container, removes the container, and rejects. The message of the error has that output. Its `cause` is the readiness error.

### Shared servers

`reuse(body, options)` finds the server for this configuration, or creates it. The configuration is the body after the testbed adds its defaults, the `internalPort` and the package version. The order of the keys and the order of the `Env` entries do not select a different server. Docker reserves the name atomically, so concurrent processes attach to the same container. Different images, passwords, environments or labels select separate servers. A readiness failure leaves the shared server running for diagnosis. Dispose a reused server only after all its users finish: disposal stops it for every caller.

A shared server belongs to one version of `@zukhruf/testing`. Its label `dev.zukhruf.testing.version` holds that version, and the version is part of its name. At the end of a run that used Docker, the global teardown removes each shared server on its engine whose version is not this version, and each shared server that has no version label ([ADR 0012](./docs/adr/0012-a-shared-server-belongs-to-one-version-of-the-package-and-the-global-teardown-removes-the-servers-of-every-other-version.md)).

The teardown keeps the servers of a version while a test process of that version runs ([ADR 0014](./docs/adr/0014-a-test-process-holds-a-process-lease-and-the-global-teardown-keeps-the-shared-servers-of-a-version-that-has-one.md)). Each test process that calls `reuse()` holds a process lease on the engine: a small `busybox` container that runs `cat` on the input of an attach. When the process exits, also when it is killed, the attach closes and the engine removes the lease. The attach does not keep the process running. Before the teardown removes the servers of a version, it takes the sweep lease of that version, and then it looks for a process lease of that version. A test process takes its process lease, and then it looks for the sweep lease of its version. When that sweep lease exists, `reuse()` waits until the sweep ends. Thus a project on another version can use the same engine. The versions before this change hold no lease, and a teardown removes their servers once.

When you change your own body in one version, for example the image tag, the old server stays. Stop it:

```sh
docker ps -a --filter label=dev.zukhruf.testing.shared=1
docker stop <container-id>
```

The engine removes a server when it stops, so stopping also removes it. The image tag is part of the configuration: stop the server to pick up a newer image behind the same tag.

A shared server starts on the first `database()` call that needs it. When that call is in a test, the time limit of the test also counts the start of the server. Each fixture sets a time limit for the start, its readiness bound: Postgres 60 s, MySQL and MariaDB 90 s, SQL Server 180 s. When the server does not answer in that time, the call fails with "Container … was not ready" and the output of the container. The default time limit of `@zukhruf/nx/test` is 240 s: the slowest readiness bound plus 60 s for the test (see [the test area](../nx/README.md#what-the-test-target-runs)). When you change a readiness bound, change that default with it.

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

The global setup sets `ZUKHRUF_TESTING_RUN_ID` and `ZUKHRUF_TESTING_RUN_DIR` for the test processes. A `DockerTestbed` reads them from its `environment` and labels what it creates with the run. It records SSH forwards and host directories in the run's directory. It also writes a process record for its test process, and for each SSH command that it starts, while that command runs. While it asks the engine to create a container, it writes a creating record. In a run, `database()` puts the run's id in the name of each database that it creates on a shared server: `test_<run id>_<16 hex>`.

The global teardown removes the labeled containers with their anonymous volumes, the labeled volumes and the recorded paths. On each running shared server of `Postgres`, `Mysql`, `Mariadb` and `SqlServer`, it drops the databases whose name has the run's id ([ADR 0011](./docs/adr/0011-the-run-id-in-a-databases-name-is-its-owner-reference-and-one-collector-for-each-kind-drops-a-dead-runs-databases.md)). Each list and each drop on a server has the time limit of one request to the engine, 240 s. When a shared server does not answer in that time, the global teardown keeps the run's databases on that server and continues. Recovery does the same. It skips a kind whose driver the project did not install. It never removes a shared server of this version. It removes the shared servers of other versions, unless a test process of that version holds a process lease (see [Shared servers](#shared-servers)). When the engine does not remove one of these servers, the teardown keeps it and continues, and a later teardown removes it. The teardown is synchronous, because Node does not wait for an asynchronous teardown under `--test-force-exit`. When every recorded process has ended, the teardown deletes the run's records. A recorded process that still runs can still create a container. The engine can also finish a create after the test process that sent it was killed. Then the teardown keeps the records, and a later run removes what is left after that process ends. Recovery keeps the records for 240 s after a create that a killed test process started, and sweeps the run again at each start in that time.

If cleanup fails, for example because the engine is unreachable, the global teardown prints the error, keeps the run's records, and sets exit code 1. The next run on the same engine removes what the run left, from any project of this user. This is recovery. Recovery does not touch a run while its runner or one of its recorded processes lives. The records are in `$XDG_STATE_HOME/zukhruf-testing/docker-runs` (`~/.local/state/zukhruf-testing/docker-runs` by default). Do not delete a record to hide a cleanup failure.

The global setup selects the engine as the Docker CLI does, through `@zukhruf/docker`, so the Docker CLI is not necessary. It calls the engine only when a dead run on that engine has records to sweep.

On an SSH engine, run one test file at a time with `--test-concurrency=1` if the engine cannot take more. An SSH forward runs `cat` in a remote shell, so the SSH user needs a shell on the engine's host. The forward ends when the process that opened it ends, also when that process is killed.

Another Docker client can create containers for the run, for example a sandbox launcher. Give it `testbed.defaults`: its `Labels` are the run's labels, and its `HostConfig` has the default `Memory` and `NanoCpus`. A client that takes the Engine API body uses them as they are. Map them to the options of a client that has its own options. Reading `defaults` writes a process record for this process, so the global teardown keeps the run's records while this process lives.

## Databases

`Postgres`, `Mysql`, `Mariadb`, `SqlServer` and `ClickHouse` take the `environment`, such as `process.env`. The environment selects the engine and the run. Each instance makes its own `DockerTestbed` from it. Each `database()` call creates a fresh database on a shared server; disposal drops it. In a run, the name of the database has the run's id. When a test process is killed before its disposal, or a drop in disposal fails, the global teardown drops the database (see [A killed run](#a-killed-run)). Outside a run, only disposal drops it. `start()` creates a dedicated server; disposal stops it.

```ts
import { Postgres } from '@zukhruf/testing/postgres';

const postgres = new Postgres({ environment: process.env });

test('stores a record', async () => {
  await using database = await postgres.database();
  // database.connectionString. Close your clients before the scope ends.
});
```

The handle has `connectionString`, `host`, `port`, `user`, `password`, `database`, `image` and `containerId`. `Mysql` and `Mariadb` handles also have `query(sql)`. Without an image, `Mysql` runs `mysql:lts` and `Mariadb` runs `mariadb:lts`. MariaDB 11 and later have no `mysql` client, so use `Mariadb` for a MariaDB image. A `Mariadb` connection string starts with `mariadb://`, because the `mariadb` driver accepts no other scheme. Without an image, `SqlServer` picks Azure SQL Edge on an ARM engine and SQL Server 2022 elsewhere. `ClickHouse` takes an explicit `image`, and its `start()` gives a `ServiceContainer` of a dedicated server, so a test can create server-wide users and functions.

`Sqlite` creates a file-backed database in a temporary directory, with a native `DatabaseSync` connection. Disposal closes the connection and removes the directory, including WAL files. `writeLock(path, durationMs)` holds a write lock from another process, which releases it after `durationMs`, even while the caller blocks in a synchronous write.

`DuckDB` creates an in-memory database. Disposal closes the connection before the instance.

`BigQuery` creates a dataset in the project you name. Disposal deletes it with its tables and views. You provide the credentials.

## HTTP servers and streams

`new HttpServer().start(handler)` listens on `127.0.0.1` on a free port and resolves once it listens. The handle has `origin` and the native `server`. Disposal closes active connections and waits for the server to close.

The handler is a Node.js request listener. A web framework gives one for its fetch handler: `getRequestListener((request) => app.fetch(request))` from `@hono/node-server`, or `toNodeHandler((request) => auth.handler(request))` from `better-auth/node`. The handler can be async. When it rejects, the rejection stays unhandled and fails the process, as a throw does. The server never answers for a handler that failed. A handler that needs the origin can read a `const` that the test declares after the acquisition: no request arrives before the test gives the origin to a client.

`StreamHarness` gives a controlled producer, `source<T>()`, with `enqueue`, `close`, `error` and a read-only `state`, and a disposable `reader(stream)` that locks a stream without reading ahead. `collectUntilError()` returns the remaining chunks and either `completed` or `errored` with the error.

## Waiting

`timebox(fn, options)` retries `fn` until it stops throwing, every 250 ms for at most 30 seconds by default. It takes every p-retry option. `settleWithin(promise, label, ms)` rejects when a promise that cannot be cancelled does not settle in time. When an operation accepts an `AbortSignal`, pass `AbortSignal.timeout(ms)` to it instead.

## Temporary directories

`new TemporaryFiles().directory(prefix)` creates an empty directory in `os.tmpdir()`. Its name starts with `prefix`. The handle has `path` and `cleanup`. Disposal removes the directory and all that it holds.

```ts
import { TemporaryFiles } from '@zukhruf/testing/fs';

const files = new TemporaryFiles();

test('writes the report', async (t) => {
  await using directory = await files.directory('report-');
  await writeReport(join(directory.path, 'report.json'));
  t.assert.ok(existsSync(join(directory.path, 'report.json')));
});
```

`path` is the real path: the acquisition resolves symbolic links. On macOS, `os.tmpdir()` is below `/var`, and `/var` is a link to `/private/var`. git, a child process and a bind mount give the resolved path. Thus a test can compare their output with `path` directly.

On Windows, a process that still holds a file open stops its removal for a short time. Thus disposal retries the removal on `EBUSY`, `EMFILE`, `ENFILE`, `ENOTEMPTY` and `EPERM`. It retries 8 times, and it waits 50 ms longer before each retry: 50 + 100 + … + 400 = 1.8 s at most. A removal that does not fail does not wait. When the last retry fails, disposal rejects with the error.

The only option is `parent`, the directory that holds the new directory. The default is `os.tmpdir()`. A Unix socket path has a limit of 104 bytes on macOS and 108 bytes on Linux. On macOS, the real path of `os.tmpdir()` uses 56 of them. Thus give a short parent, such as `/tmp`, for a socket. Node resolves a package from the parent directories of the file that imports it. Thus give a parent in the repository when a file in the directory imports a package of the repository.

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
