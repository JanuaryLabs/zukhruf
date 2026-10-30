# A project gives its shared servers to `prebuild`, and the global setup creates them before the run

Status: design for review (#3404). The code does not exist yet.

A shared server starts on the first `reuse()` that needs it. Each database fixture calls `reuse()` in `database()`, and a test calls `database()`. Thus the time limit of the first test that needs a server also counts the start of that server: the pull of the image and the boot. Node's time limit counts the test function, and the acquisition is in the test function. Meszaros (_xUnit Test Patterns_, 2007) calls this Lazy Setup of a Shared Fixture.

A cold start happens on each CI run. It also happens on each machine after a new version of this package, because the version is part of the configuration of a shared server (ADR 0012). Three places found this problem:

1. zukhruf `packages/mutex`. Its file `src/testing/docker-global-setup.ts` acquires the fixture of each store case with the reach `'network'` (Postgres, SQL Server, MySQL, MariaDB and the Docker engine store), and disposes it. Then it calls `globalSetup`.
2. text2sql `packages/adapters`. After the label change of 0.4.1, a cold start failed `MysqlAdapter basic_select_literal` at the 60 s default of `@zukhruf/nx/test`. Commit `b35d8c51` added a copy of the mutex file with `Mysql` and `Mariadb` (`password: 'Test12345'`), `Postgres` (`image: 'postgres:17-alpine'`) and `SqlServer` (`image: SQL_SERVER_FULL_IMAGE`). The ledger entry is K3 in text2sql `docs/copied-test-code.md`. A run on a cold engine passed 313 of 313 tests, and the slowest test took 3.2 s.
3. deepagents `packages/context`. On a cold Azure SQL Edge boot, two tests of `test/sqlserver/branching.test.ts` were cancelled at 60 s. A run on the warm servers passed 1569 of 1569 tests. Its last green CI passed with the same limit on cold servers, so the failure shows on slow machines. This project has no copy yet. Its tests use `Postgres` with no image, `Postgres` with `postgres:18-alpine`, `SqlServer` with no image and `SqlServer` with `SQL_SERVER_FULL_IMAGE`.

Three repositories have this knowledge, and it does not use `mock`. Thus it goes into an area (ADR 0016).

## What is the same, and what is different

The same in the two copies:

- Call each acquisition at the same time, dispose each handle, and wait for all of them.
- Do this before `globalSetup` starts the run.
- Re-export `globalTeardown`.

Different, and a parameter: the list of acquisitions and their options.

Different in kind, and it stays with each project: which servers its tests use, and how it finds them. mutex reads its table of store cases and filters it by reach. One of its fixtures is not a database: the Docker engine store. text2sql and deepagents write the list. Only the project knows this list, so the package does not find the servers by itself.

## Why before the run

The acquisitions must run before `globalSetup` starts the run. In a run, the first acquisition of a `DockerTestbed` writes a process record for its process (`src/docker/testbed.ts:97`, `:129`). In the global setup, that process is the runner. The global teardown also runs in the runner, so the runner is alive at that time. The teardown deletes the run's records only when no recorded process is alive (`src/scripts/docker-global-setup.ts:246`). Thus an acquisition in the run makes each teardown keep the run's records, and a later recovery must sweep the run. Before the run, the environment has no run, so the testbed writes no record, and the database names have no run id. Disposal drops each database.

The runner selects the engine before the run as the Docker CLI does. `globalSetup` makes the same selection and gives it to the test processes as `DOCKER_HOST` (`src/scripts/docker-global-setup.ts:198-226`). Thus the prebuilt servers are on the engine of the tests.

## Decision

`@zukhruf/testing/docker-global-setup` exports `prebuild`:

```ts
function prebuild(
  acquisitions: readonly (() => Promise<AsyncDisposable>)[],
): () => Promise<void>;
```

It returns a global setup. The global setup calls all the acquisitions at the same time, and disposes each handle when its acquisition resolves. It waits until all of them end, also when one fails. Thus no handle stays open when the runner continues. When one or more acquisitions fail, it rejects with an `AggregateError` of the errors, and Node runs no test. Then it calls `globalSetup`.

The project keeps its file `src/testing/docker-global-setup.ts`. Node's `--test-global-setup` takes a path, and resolves it from the working directory, not as a package name. `@zukhruf/nx/test` uses the project's own file before the file of this package. The file becomes an export of `prebuild(...)` and the re-export of `globalTeardown`.

The term is Prebuilt Fixture of Meszaros (_xUnit Test Patterns_, 2007): the Shared Fixture is created before the tests that use it run. The name `prebuild` is from that term. It is not a new term.

`globalSetup` and `globalTeardown` do not change. `@zukhruf/nx` does not change.

## Considered Options

- **`prebuild` in `@zukhruf/testing/docker-global-setup` takes the acquisitions and returns a global setup.** ACCEPTED. It holds the knowledge that is the same in the copies: concurrent acquisitions, a disposal for each, the wait for all, and the order before the run. It takes the part that is different as a list. An acquisition returns an `AsyncDisposable`, so it accepts the database fixtures and the fixtures of mutex, also the Docker engine store, which is not a database.
- **`prebuild` takes database fixtures, objects with `database()`, in place of acquisitions.** REJECTED. The Docker engine store of mutex has no `database()`. mutex already has its acquisitions in its table of store cases, and a function is the smallest shape that both kinds give.
- **The fixtures start their shared servers where the time limit does not count.** REJECTED. Node's time limit counts the test function, and the test calls `database()`. A constructor that starts the server does not move the wait out of the test: the first `database()` still waits for the same start. Only a top-level `await` in each test file moves it, and that changes each file that uses a fixture, for example 12 files in deepagents `packages/context`. A start in a constructor also starts a server for a file whose tests a filter skips. A `before` hook is not allowed in these repositories.
- **A longer time limit.** REJECTED. The text2sql backends have `--test-timeout=120000`, but a longer limit applies to every test, so a test that hangs fails later. The cold start of SQL Server on an emulated engine has no known maximum.
- **An option of `@zukhruf/nx/test` that names the servers.** REJECTED. The options of a project in Nx are JSON, so they cannot hold an acquisition with its options. The plugin then must know the fixtures of `@zukhruf/testing`: the dependency goes from the plugin to the fixtures. A project without Nx does not get the option.
- **No change, and each project keeps a copy.** REJECTED. A third copy in deepagents is the third place (ADR 0016). A fix to one copy, for example the wait for all the acquisitions when one fails, must go into each copy. The two copies today use `Promise.all`, which rejects at the first failure while the other acquisitions continue.

## How each place uses it

1. zukhruf `packages/mutex/src/testing/docker-global-setup.ts`. In the same commit as `prebuild`, the file becomes:

   ```ts
   export const globalSetup = prebuild(
     storeCases
       .filter((store) => store.reach === 'network')
       .map((store) => () => store.fixture(process.env)),
   );
   ```

   It keeps the re-export of `globalTeardown`, and its comment says why the project prebuilds. The mutex tests use the source of this package, so no release is necessary.

2. text2sql `packages/adapters/src/testing/docker-global-setup.ts`. After the release of `prebuild`, text2sql moves to that version. Its file gives the four acquisitions of its tests to `prebuild`, with the options of today. Remove entry K3 from `docs/copied-test-code.md`. The text2sql commit runs through its pre-commit hook.
3. deepagents `packages/context`. After the release, add `src/testing/docker-global-setup.ts` with four acquisitions: `Postgres` with no image, `Postgres` with `image: 'postgres:18-alpine'`, `SqlServer` with no image and `SqlServer` with `image: SQL_SERVER_FULL_IMAGE`. On an ARM engine, `SqlServer` with no image selects Azure SQL Edge, so that server is different from the full image. On an x86 engine both select the full image, and the configuration is the same, so the two acquisitions find one server. The project has the tag `test:docker`, so `@zukhruf/nx/test` uses the new file. Verify with a run on a cold engine.

Close backlog #3404 when the three places use `prebuild`.

## Consequences

- A project that uses shared servers in its tests writes a global setup file of a few lines. A project without shared servers deletes the file that only re-exports, as before.
- The list of acquisitions must have the options of the tests. A server with other options, for example another image, is a different server, and its first test still waits for its start. Nothing checks the list against the tests.
- The run starts after the slowest cold start. A failed start stops the run before its first test, with the error of the fixture.
- On a warm engine, each acquisition only creates and drops a database.
