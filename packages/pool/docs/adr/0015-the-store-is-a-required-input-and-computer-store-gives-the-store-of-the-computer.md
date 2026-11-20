# The store is a required input, and computerStore gives the store of the computer

Status: Accepted 2026-11-20 (backlog #3527). `computerStore` is built (2026-11-16), with the ledger in `docs/copied-code.md`. `PoolWorkers` takes the path of a SQLite file and opens it, with its folder; a `postgres://` address throws a `TypeError` until [ADR 0025](./0025-many-computers-share-one-postgres-store-and-each-computer-keeps-its-own-owner.md) is built. `Pool` takes the same path (2026-11-20), and refuses a `postgres://` address the same way.

Map tickets 04, 05 and 08 said that a pool with no setting finds the store of the computer by itself, in the user's data folder. Map ticket 18 found what that does to a test. A test in elt or context-compiler that builds the `vision` pool sends its jobs to the user's real owner, or becomes the owner of the user's real jobs. A name that only the test uses keeps the jobs apart, but the test still writes to the user's store file.

Every job queue takes its store as an input, and every test setup gives a store of its own (research 18):

| System   | The store is                          | A test gives                   |
| -------- | ------------------------------------- | ------------------------------ |
| pg-boss  | a connection string and a `schema`    | a schema for each test         |
| Temporal | the address of a server               | a test server for each test    |
| Celery   | a broker URL                          | a broker in memory             |
| Oban     | a repo                                | a test mode                    |
| BullMQ   | a Redis connection, localhost default | its own connection or `prefix` |
| Sidekiq  | a Redis URL, localhost default        | its own database number        |

None of them finds a store in the user's data folder with no setting. The workspace rule is that code takes the environment as an input, and a test never changes the environment (root ADR 0004 for the clock; [ADR 0009](./0009-a-sizing-reads-the-capacity-from-the-computer-that-the-caller-gives.md) for the computer). A default that reads `XDG_STATE_HOME` or `LOCALAPPDATA` itself breaks that rule.

## Decision

From map ticket 18 (Ezz, 2026-11-14: "Required input (Recommended)"). It replaces the "no setting" of tickets 04, 05 and 08.

- `store` is a required input of `Pool` and `PoolWorkers`. It is an address string (map ticket 05, Ezz: "Yes, an address"). The pool builds the store from it:
  - **A path of a SQLite file**: the store of one computer. The pool opens it as a `SqliteJobQueue` of `@zukhruf/sqlite-queue`, sends its wakes with `@zukhruf/sqlite-notify` on the same file, and keeps the claim files of its election in the folder of the file.
  - **A `postgres://` address**: one store for many computers, through pg-boss ([ADR 0025](./0025-many-computers-share-one-postgres-store-and-each-computer-keeps-its-own-owner.md)).
- `computerStore(env)` gives the store of the computer for the user of the host: the file `zukhruf-pool/store.sqlite` in the state folder of that user. A host gives `computerStore(process.env)`. A test gives the path of a temporary file.

| System  | The state folder                                      |
| ------- | ----------------------------------------------------- |
| macOS   | `$HOME/Library/Application Support`                   |
| Linux   | `$XDG_STATE_HOME`, or `$HOME/.local/state` when unset |
| Windows | `%LOCALAPPDATA%`                                      |

- **The platform.** `computerStore` reads `process.platform` to choose the folder, and takes `env` as its input for the variables. Go's `os.UserConfigDir` reads `runtime.GOOS` and the environment in the same way. The platform is fixed for the life of a process, and a test does not change it. The environment can differ for each user and each test, so it is an input. This was decided on 2026-11-16 by the leaders (Ezz: "I trust your recommendation ... follow the top performers").
- When the variable that the platform needs is not set, for example `HOME` on macOS, `computerStore` throws. Go's `os.UserConfigDir` returns the error "$HOME is not defined".
- The XDG Base Directory specification defines state as data that "should persist between (application) restarts" and that is not important or portable enough for the data folder. A job queue file is such data. `@zukhruf/testing` already keeps its state in `XDG_STATE_HOME`.
- **Who opens and who maintains the store.** Every `Pool` and `PoolWorkers` opens the store and creates the queue of its revision ([ADR 0014](./0014-pool-and-pool-workers-take-one-worker-kind.md)). Every instance runs the store's maintenance, and a claim in the store decides who runs each pass. pg-boss, `@zukhruf/sqlite-queue` (`src/supervisor.ts`), BullMQ and Solid Queue do this. Oban's elected leader is the exception. The pool adds nothing.
- **Two releases on one file.** Old plugin servers run on after an update (#2127). A newer release of `@zukhruf/sqlite-queue` changes an older file. An older release leaves a newer file alone and goes on, as pg-boss does on a newer schema (sqlite-queue ADR 0006, backlog #4369, built). Two revisions of one worker kind are [ADR 0022](./0022-the-newest-revision-takes-over-and-an-owner-refuses-a-job-of-an-older-revision.md).

## Consequences

- The code of a host is the same on every computer: it always gives `computerStore(process.env)`, or a Postgres address to join computers. Location transparency holds ([ADR 0011](./0011-every-pool-is-a-pool-for-the-computer-and-one-owner-pulls-its-jobs-from-a-store-that-every-host-writes-to.md)).
- A test cannot join the user's pool by luck.
- The folder name `zukhruf-pool` is a name of this package, after the folder `zukhruf-testing` of `@zukhruf/testing`.
- The state folder by platform is the second place in zukhruf after `@zukhruf/testing`. The build copies it with a ledger in `docs/copied-code.md` (Rule of Three, strike 2).
- The Vision helpers of a test still compile through the one `ANECompilerService` of the computer (#3868). The owner caps only the jobs of its own pool. A cap across the test pools of a computer stays out of scope.
