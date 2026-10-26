# @zukhruf/testing

Disposable fixtures for integration tests on Node.js: Docker containers and database servers, SQLite and DuckDB databases, BigQuery datasets, HTTP servers and controlled streams. Each acquisition returns a handle that `await using` cleans up, also when the test fails. A background server has no handle: it lives until the process exits. Node's global setup and global teardown remove what a killed test run left behind.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Areas

Each area has its own import path, so a test loads only the drivers it uses. The four drivers are optional peer dependencies: install the one an area names.

| Import                        | Gives                                                              | Needs                    |
| ----------------------------- | ------------------------------------------------------------------ | ------------------------ |
| `@zukhruf/testing/node`       | Native `test`, `it`, `suite`, `describe` with `.each`              |                          |
| `@zukhruf/testing/async`      | `timebox`, `settleWithin`                                          |                          |
| `@zukhruf/testing/docker`     | `DockerFixtures`, `ServiceContainer`, `DockerDirectory`, `TestRun` | a Docker engine          |
| `@zukhruf/testing/postgres`   | `Postgres`                                                         | a Docker engine          |
| `@zukhruf/testing/mysql`      | `Mysql`                                                            | a Docker engine          |
| `@zukhruf/testing/mariadb`    | `Mariadb`                                                          | a Docker engine          |
| `@zukhruf/testing/sqlserver`  | `SqlServer`, `SQL_SERVER_FULL_IMAGE`, `SQL_SERVER_EDGE_IMAGE`      | a Docker engine, `mssql` |
| `@zukhruf/testing/clickhouse` | `ClickHouse`                                                       | a Docker engine          |
| `@zukhruf/testing/sqlite`     | `Sqlite`                                                           |                          |
| `@zukhruf/testing/duckdb`     | `DuckDB`                                                           | `@duckdb/node-api`       |
| `@zukhruf/testing/bigquery`   | `BigQuery`                                                         | `@google-cloud/bigquery` |
| `@zukhruf/testing/http`       | `HttpServer`                                                       |                          |
| `@zukhruf/testing/streams`    | `StreamHarness`                                                    |                          |
| `@zukhruf/testing/fs`         | `TemporaryFiles`                                                   |                          |
| `@zukhruf/testing/process`    | `Environment`                                                      |                          |
| `@zukhruf/testing/msw`        | `Msw`                                                              | `msw`                    |

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

A `DockerFixtures` acquires containers, volumes and directories on one engine. The `environment` that you give it, such as `process.env`, selects the engine as the Docker CLI does: `DOCKER_HOST`, `DOCKER_CONTEXT`, or the current context in the Docker config directory. The `@zukhruf/docker` client sends the requests to the Engine API, so no Docker CLI is necessary. The engine is connected on the first acquisition, and every handle keeps that engine. It can be a local Unix socket, the named pipe of Docker Desktop on Windows (`npipe://`), or an SSH engine (`ssh://`).

A test that needs Docker has no skip option. When the engine does not answer, the first acquisition fails with "Docker is required for container-backed tests" and the connection failure as the cause. Start Docker to run these tests.

```ts
import { DockerFixtures } from '@zukhruf/testing/docker';

const docker = new DockerFixtures({ environment: process.env });

test('a holder in another container', async () => {
  await using volume = await docker.volume();
  await using holder = await docker.start({
    image: 'node:lts-alpine',
    hostname: 'app',
    mounts: [{ source: volume.name, target: '/locks' }],
    command: ['node', '--eval', 'setInterval(() => {}, 1000)'],
  });
  await holder.kill();
  const { exitCode, stdout } = await docker.run({
    image: 'node:lts-alpine',
    mounts: [{ source: volume.name, target: '/locks', readOnly: true }],
    command: ['ls', '/locks'],
  });
});
```

| Member           | Gives                                                                                                                                       | Returns                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `start(options)` | A container this process owns. It stays after it stops, so its logs remain, until disposal removes it.                                      | `OwnedContainer`                  |
| `serve(options)` | A dedicated server whose `internalPort` answers on `127.0.0.1` of this machine. Failure or disposal removes it.                             | `ServiceContainer`                |
| `reuse(options)` | One server per configuration on the engine, shared across processes and runs.                                                               | `ServiceContainer`                |
| `run(options)`   | A container that runs to completion. It gives the output and the exit code, and removes the container. A non-zero exit code does not throw. | `ExecResult`                      |
| `volume()`       | A named volume.                                                                                                                             | `OwnedVolume`                     |
| `directory()`    | A directory on the engine's host, for bind mounts. It has `mkdir`, `writeFile`, `readFile`, `chmod` and `symlink`.                          | `DockerDirectory`                 |
| `client()`       | The `@zukhruf/docker` client of the engine, for each other Engine API call, such as `info()` or `containers.find(id)`.                      | `Docker` (from `@zukhruf/docker`) |
| `defaults`       | The default `resources` and the run's `labels`.                                                                                             |                                   |

Options: `image`, `command`, `name`, `hostname`, `env`, `labels`, `mounts`, `tmpfs`, `ipcHost`, `memory` (default `1g`), `cpus` (default `1`), `memorySwappiness`. `serve` and `reuse` also take `internalPort` and `healthy`, a function that throws until the server is ready; it runs on every acquisition. Use `timebox` for polling inside it. When the engine does not have the image, the acquisition pulls it, as `docker run` does.

`OwnedContainer`, `OwnedVolume`, `ExecResult` and `Docker` are types of `@zukhruf/docker`. A container has `id`, `exec({ Cmd })`, `logs()`, `kill(signal)` and `inspect()`. `exec` gives `exitCode`, `stdout`, `stderr` and `output`, and it does not throw for a non-zero exit code. The text keeps its last newline. Disposal removes the container with its anonymous volumes.

A `ServiceContainer` has `container`, `host` and `port`. On an SSH engine, the port is a local forward that belongs to the acquiring process. `disconnect()` closes that forward and leaves the container running for its other users. If the forward ended before, for example because the SSH connection died, `disconnect()` rejects with what ssh printed. `cleanup()` and disposal also remove the container of a dedicated server. When the removal fails too, `cleanup()` rejects with a `SuppressedError` that holds both errors. Nothing is written to stderr. A probe in `healthy` gets the `ServiceContainer`: call `container.exec(...)` on it, and do not destructure `exec`.

### Shared servers

`reuse(options)` finds the server for this configuration, or creates it. Docker reserves the name atomically, so concurrent processes attach to the same container. Different images, passwords, environments or labels select separate servers. A readiness failure leaves the shared server running for diagnosis. Dispose a reused server only after all its users finish: disposal stops it for every caller.

Shared servers remain until you stop them:

```sh
docker ps -a --filter label=dev.zukhruf.testing.shared=1
docker stop <container-id>
```

The engine removes a server when it stops, so stopping also removes it. The image tag is part of the configuration: stop the server to pick up a newer image behind the same tag.

## A killed run

Disposal cleans up after a test that ends. A test process that is killed (a timeout with `--test-force-exit`, Ctrl-C, an out-of-memory kill) does not dispose its handles. A running container does not stop by itself. Thus Node's global setup and global teardown make the test processes of one `node --test` invocation into one run. Re-export the two functions from one file in your project:

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

The global setup sets `ZUKHRUF_TESTING_RUN_ID` and `ZUKHRUF_TESTING_RUN_DIR` for the test processes. A `DockerFixtures` reads them from its `environment` and labels what it creates with the run. It records SSH forwards and host directories in the run's directory. It also writes a process record for its test process, and for each SSH command that it starts, while that command runs. While it asks the engine to create a container, it writes a creating record.

The global teardown removes the labeled containers with their anonymous volumes, the labeled volumes and the recorded paths. It never removes shared servers. The teardown is synchronous, because Node does not wait for an asynchronous teardown under `--test-force-exit`. When every recorded process has ended, the teardown deletes the run's records. A recorded process that still runs can still create a container. The engine can also finish a create after the test process that sent it was killed. Then the teardown keeps the records, and a later run removes what is left after that process ends.

If cleanup fails, for example because the engine is unreachable, the global teardown prints the error, keeps the run's records, and sets exit code 1. The next run on the same engine removes what the run left, from any project of this user. This is recovery. Recovery does not touch a run while its runner or one of its recorded processes lives. The records are in `$XDG_STATE_HOME/zukhruf-testing/docker-runs` (`~/.local/state/zukhruf-testing/docker-runs` by default). Do not delete a record to hide a cleanup failure.

The global setup selects the engine as the Docker CLI does, through `@zukhruf/docker`, so the Docker CLI is not necessary. It calls the engine only when a dead run on that engine has records to sweep.

On an SSH engine, run one test file at a time with `--test-concurrency=1` if the engine cannot take more. An SSH forward runs `cat` in a remote shell, so the SSH user needs a shell on the engine's host. The forward ends when the process that opened it ends, also when that process is killed.

To pass the run to another container API, spread `docker.defaults`: it holds the default `resources` and the run's `labels`.

## Databases

`Postgres`, `Mysql`, `Mariadb`, `SqlServer` and `ClickHouse` take the `environment`, such as `process.env`. The environment selects the engine and the run. Each instance makes its own `DockerFixtures` from it. Each `database()` call creates a fresh database on a shared server; disposal drops it. `start()` creates a dedicated server; disposal stops it.

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

Some modules read an origin when they load, so every test in the file uses the same server. `background(handler)` starts a background server for them. It listens until the process exits and never keeps the process running, also while a connection to it is open. It returns only `origin`, because nothing disposes it. Use `start` when only one test reads the origin.

```ts
import { HttpServer } from '@zukhruf/testing/http';

const keys = await new HttpServer().background((request, response) => {
  response.end(JSON.stringify(jwks));
});
process.env.KEYS_URL = keys.origin;
const { verify } = await import('./verify.ts');
```

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

`new Environment().set(values)` assigns each key on `process.env` and returns an environment scope. The value `undefined` deletes the key for the scope. Disposal restores each key to its earlier value.

```ts
import { Environment } from '@zukhruf/testing/process';

const environment = new Environment();

test('reads the region', (t) => {
  using scope = environment.set({
    AWS_REGION: 'eu-west-1',
    AWS_PROFILE: undefined,
  });
  t.assert.equal(region(), 'eu-west-1');
});
```

A key that was absent before the scope is deleted at restore. It does not become the string `"undefined"`. An empty string is a value: a key that held `''` holds `''` again. The scope assigns each key on the real `process.env` object. It does not replace the object and does not use `Object.defineProperty`. Native addons read the real object, and Node resets its `TZ` cache only on an assignment.

One scope at a time holds a key. A second `set` that names a key of an open scope throws, and the error names the key. Thus two tests that run at the same time cannot restore each other's values. To set several keys, give them to one `set`.

A module that reads a variable when it loads keeps the value that it read. The restore does not change that value, and Node loads a module only once in a process. Thus set the scope first, then load the module with `await import()`. Or run the code in a child process.

A child process copies the environment when it starts. It sees the scope only if it starts while the scope is open and inherits the environment. Thus give the values to the child as `env`, such as `spawn(command, args, { env: { ...process.env, REGION: 'eu-west-1' } })`. Then the test needs no scope.

To put a directory first on `PATH`, join it with `path.delimiter`, which is `:` on Unix and `;` on Windows:

```ts
import path from 'node:path';

using scope = environment.set({
  PATH: [binDirectory, process.env.PATH ?? ''].join(path.delimiter),
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

An interception is always strict: the server listens with `onUnhandledFrame: 'error'`. A request that no handler answers fails, and the error names it. There is no option for a different strategy.

`requests` holds a clone of each request that the server receives, in the order of arrival. A clone keeps its body, so the test can read the body after a handler read the original.

`server` is the msw `SetupServerApi`. Use `interception.server.use(...handlers)` to add handlers for a part of the test.

An interception also receives the requests to a local server, such as an `HttpServer` of the same test. To send them to that server, give a handler that passes them through:

```ts
import { http, passthrough } from 'msw';

using interception = msw.intercept(
  http.all('*', ({ request }) => {
    const { hostname } = new URL(request.url);
    if (hostname === '127.0.0.1' || hostname === 'localhost') {
      return passthrough();
    }
  }),
  http.get('https://api.example.com/user', () => HttpResponse.json({ id: 1 })),
);
```

The driver is msw 3 (`msw ^3.0.3`), which needs Node.js 22.12 or later. Install it next to this package.

## Development

```sh
npx nx run testing:test        # builds, then runs the tests
npx nx run testing:typecheck   # formats, lints, then type checks
```

The tests that need Docker run on every machine, and fail when the engine does not answer. CI runs every test on Linux, where Docker runs Linux containers. The `test` target runs alone (`parallelism: false`): Nx starts no other task while it runs, because its database servers slow down the timing tests of the other projects.
