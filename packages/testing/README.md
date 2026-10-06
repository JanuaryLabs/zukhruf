# @zukhruf/testing

Disposable fixtures for integration tests on Node.js: Docker containers and database servers, SQLite and DuckDB databases, BigQuery datasets, HTTP servers and controlled streams. Each acquisition returns a handle that `await using` cleans up, also when the test fails. A supervisor removes what a killed test run left behind.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Areas

Each area has its own import path, so a test loads only the drivers it uses. The three drivers are optional peer dependencies: install the one an area names.

| Import                        | Gives                                                                                                        | Needs                    |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `@zukhruf/testing/async`      | `timebox`, `settleWithin`                                                                                    |                          |
| `@zukhruf/testing/docker`     | `Docker`, `Container`, `ServiceContainer`, `DockerVolume`, `DockerDirectory`, `TestRun`, `skipWithoutDocker` | Docker CLI               |
| `@zukhruf/testing/postgres`   | `Postgres`                                                                                                   | Docker CLI               |
| `@zukhruf/testing/mysql`      | `Mysql`                                                                                                      | Docker CLI               |
| `@zukhruf/testing/sqlserver`  | `SqlServer`, `SQL_SERVER_FULL_IMAGE`, `SQL_SERVER_EDGE_IMAGE`                                                | Docker CLI, `mssql`      |
| `@zukhruf/testing/clickhouse` | `ClickHouse`                                                                                                 | Docker CLI               |
| `@zukhruf/testing/sqlite`     | `Sqlite`                                                                                                     |                          |
| `@zukhruf/testing/duckdb`     | `DuckDB`                                                                                                     | `@duckdb/node-api`       |
| `@zukhruf/testing/bigquery`   | `BigQuery`                                                                                                   | `@google-cloud/bigquery` |
| `@zukhruf/testing/http`       | `HttpServer`                                                                                                 |                          |
| `@zukhruf/testing/streams`    | `StreamHarness`                                                                                              |                          |

It needs Node.js 24.4 or later.

## Docker

A `Docker` is the engine the Docker CLI selects. It resolves the engine once, on first use, and every handle it returns keeps that engine. It supports local Unix sockets and SSH engines (`ssh://`); it does not support Windows named pipes.

```ts
import { Docker, TestRun, skipWithoutDocker } from '@zukhruf/testing/docker';

const docker = new Docker({ testRun: TestRun.fromEnvironment(process.env) });
const skip = await skipWithoutDocker(docker, process.env);

test('a holder in another container', { skip }, async () => {
  await using volume = await docker.volume();
  await using holder = await docker.start({
    image: 'node:26-alpine',
    hostname: 'app',
    mounts: [{ source: volume.name, target: '/locks' }],
    command: ['node', '--eval', 'setInterval(() => {}, 1000)'],
  });
  await holder.kill();
  const output = await docker.run({
    image: 'node:26-alpine',
    mounts: [{ source: volume.name, target: '/locks', readOnly: true }],
    command: ['ls', '/locks'],
  });
});
```

| Method           | Starts                                                                                                                                         | Returns            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `start(options)` | A container this process owns. It stays after it stops, so its logs remain, until disposal removes it.                                         | `Container`        |
| `serve(options)` | A dedicated server whose `internalPort` answers on `127.0.0.1` of this machine. Failure or disposal stops it, and a stopped server is removed. | `ServiceContainer` |
| `reuse(options)` | One server per configuration on the engine, shared across processes and runs.                                                                  | `ServiceContainer` |
| `run(options)`   | A container that runs to completion. Returns its standard output and removes it.                                                               | `string`           |
| `volume()`       | A named volume.                                                                                                                                | `DockerVolume`     |
| `directory()`    | A directory on the engine's host, for bind mounts. It has `mkdir`, `writeFile`, `readFile`, `chmod` and `symlink`.                             | `DockerDirectory`  |

Options: `image`, `command`, `name`, `hostname`, `env`, `labels`, `mounts`, `tmpfs`, `ipcHost`, `memory` (default `1g`), `cpus` (default `1`), `memorySwappiness`. `serve` and `reuse` also take `internalPort` and `healthy`, a function that throws until the server is ready; it runs on every acquisition. Use `timebox` for polling inside it.

A `Container` has `containerId`, `exec(command)`, `logs()`, `kill(signal)` and `cleanup()`. Disposal removes it with its anonymous volumes. A `ServiceContainer` also has `host` and `port`; on an SSH engine the port is a local forward that belongs to the acquiring process. `disconnect()` closes that forward and leaves the container running for its other users.

### Shared servers

`reuse(options)` finds the server for this configuration, or creates it. Docker reserves the name atomically, so concurrent processes attach to the same container. Different images, passwords, environments or labels select separate servers. A readiness failure leaves the shared server running for diagnosis. Dispose a reused server only after all its users finish: disposal stops it for every caller.

Shared servers remain until you stop them:

```sh
docker ps -a --filter label=dev.zukhruf.testing.shared=1
docker stop <container-id>
```

They run with `--rm`, so stopping also removes them. The image tag is part of the configuration: stop the server to pick up a newer image behind the same tag.

### Skipping without Docker

`skipWithoutDocker(docker, process.env)` returns the `skip` option of a test that needs Docker. `ZUKHRUF_TESTING_DOCKER` decides:

| Value      | Result                                                                                |
| ---------- | ------------------------------------------------------------------------------------- |
| `required` | Runs. Throws when Docker does not answer, so a machine that must run the tests fails. |
| `skip`     | Skips.                                                                                |
| unset      | Runs when Docker answers, skips with a reason when it does not.                       |

## The supervisor

Disposal cleans up after a test that ends. A test process that is killed (a timeout, Ctrl-C, `--test-force-exit`) never disposes its handles, and a running container does not stop by itself. The `zukhruf-docker-tests` command runs `node --test` as one supervised run:

```sh
zukhruf-docker-tests --test-force-exit "src/**/*.test.ts"
```

It passes its arguments to `node --test`, and sets `ZUKHRUF_TESTING_RUN_ID` and `ZUKHRUF_TESTING_RUN_DIR` for the test processes. A `Docker` built with `TestRun.fromEnvironment(process.env)` labels what it creates with the run, and records SSH forwards and host directories in the run's directory. When the test processes exit, the supervisor stops their process group and removes the labeled containers with their anonymous volumes, the labeled volumes and the recorded paths. It never removes shared servers.

If cleanup fails, for example because the engine is unreachable, the supervisor exits with an error and keeps the run's record. The next run on the same engine removes what it left, from any project of this user. The records are in `$XDG_STATE_HOME/zukhruf-testing/docker-runs` (`~/.local/state/zukhruf-testing/docker-runs` by default). Never delete a record to hide a cleanup failure.

On an SSH engine the supervisor runs one test file at a time, unless you pass `--test-concurrency`. It runs on Linux and macOS: it stops a run as a process group, which Windows does not have.

To pass the run to another container API, spread `docker.defaults`: it holds the default `resources` and the run's `labels`.

## Databases

`Postgres`, `Mysql` and `SqlServer` take the `docker` to run on. Each `database()` call creates a fresh database on a shared server; disposal drops it. `start()` creates a dedicated server; disposal stops it.

```ts
import { Postgres } from '@zukhruf/testing/postgres';

const postgres = new Postgres({ docker });

test('stores a record', { skip }, async () => {
  await using database = await postgres.database();
  // database.connectionString. Close your clients before the scope ends.
});
```

The handle has `connectionString`, `host`, `port`, `user`, `password`, `database`, `image` and `containerId`. `Mysql` handles also have `query(sql)`. Without an image, `SqlServer` picks Azure SQL Edge on an ARM engine and SQL Server 2022 elsewhere. `ClickHouse` takes an explicit `image` and starts a dedicated server, so a test can create server-wide users and functions.

`Sqlite` creates a file-backed database in a temporary directory, with a native `DatabaseSync` connection. Disposal closes the connection and removes the directory, including WAL files. `writeLock(path, durationMs)` holds a write lock from another process, which releases it after `durationMs`, even while the caller blocks in a synchronous write.

`DuckDB` creates an in-memory database. Disposal closes the connection before the instance.

`BigQuery` creates a dataset in the project you name. Disposal deletes it with its tables and views. You provide the credentials.

## HTTP servers and streams

`new HttpServer().start(handler)` listens on `127.0.0.1` on a free port and resolves once it listens. The handle has `origin` and the native `server`. Disposal closes active connections and waits for the server to close.

`StreamHarness` gives a controlled producer, `source<T>()`, with `enqueue`, `close`, `error` and a read-only `state`, and a disposable `reader(stream)` that locks a stream without reading ahead. `collectUntilError()` returns the remaining chunks and either `completed` or `errored` with the error.

## Waiting

`timebox(fn, options)` retries `fn` until it stops throwing, every 250 ms for at most 30 seconds by default. It takes every p-retry option. `settleWithin(promise, label, ms)` rejects when a promise that cannot be cancelled does not settle in time. When an operation accepts an `AbortSignal`, pass `AbortSignal.timeout(ms)` to it instead.

## Development

```sh
npx nx run testing:test        # builds, then runs the tests
npx nx run testing:typecheck   # formats, lints, then type checks
```

The Docker-backed tests follow `ZUKHRUF_TESTING_DOCKER`. CI skips them on every operating system, and `.github/workflows/docker.yml` runs them on Linux with `required` when this package changes.
