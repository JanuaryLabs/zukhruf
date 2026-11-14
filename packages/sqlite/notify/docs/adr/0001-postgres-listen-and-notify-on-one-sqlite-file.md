# Postgres's LISTEN and NOTIFY on one SQLite file

A commit in one program on a SQLite file tells no other program. `@zukhruf/sqlite-queue` states this as a divergence from pg-boss: "`useListenNotify` wakes the workers of this `SqliteJobQueue` only" (`packages/sqlite/queue/README.md`, backlog #4334). The pool needs the same push on one computer (map tickets 11 and 20). Ezz decided on 2026-11-13 that a missing capability goes to the package that must have it. A notification across programs on a SQLite file is a capability of the SQLite family, not of the queue or the pool.

Postgres has the capability, with a contract of 13 lines (research 19 §1: the NOTIFY, LISTEN and protocol pages of the Postgres 18 docs, and the header of `src/backend/commands/async.c`). pg-boss and `pg` (node-postgres) are built on it. When this package gives a new API, a host that runs on both stores writes its code twice.

## Decision

The package gives Postgres's API and contract, with the names of Postgres and `pg`:

- `listen(channel)`, `unlisten(channel)` and `notify(channel, payload)`, Postgres's three commands. `notify` is synchronous, so that it can run inside a synchronous transaction of the family ([ADR 0004](./0004-the-wake-goes-out-after-the-synchronous-transaction.md)).
- A notification is the `Notification` of `pg` 8.23.1 (`@types/pg` `index.d.ts:112-116`, and `NotificationResponseMessage` of `pg-protocol` 1.16.1): `{ processId, channel, payload }`. The payload is always a string, as `pg-protocol` gives it, so the type is assignable to `pg`'s.
- It comes as the `notification` event of an `EventEmitter`, as on `pg`'s `Client`. A failure that no caller awaits goes to `error`, as in `pg` and `@zukhruf/sqlite-queue`.
- `processId` is the sending program's `process.pid`. Postgres gives the process id of the sender's server process (`async.c:112-117`), and a program drops its own notifications by it. Two instances in one program share it.
- The limits and the messages are Postgres's (`async.c:600-622`): a channel name cannot be empty and must be shorter than `NAMEDATALEN` (64) bytes; a payload must be shorter than `NOTIFY_PAYLOAD_MAX_LENGTH` (8000) bytes. The channel is a string, as `pg_notify(channel, payload)` takes it, so its case is kept.
- One line is stronger: the queue is a table of the file, so a crash loses no committed notification (Postgres C12 loses its queue). One line is not given: C7 ([ADR 0006](./0006-identical-notifications-of-one-transaction-are-not-folded.md)).

The class follows the family. `{ path }` or `{ database }` as in `@zukhruf/sqlite-queue`: with `path` the package owns the connection, with `database` the caller does. The two are a union, so a call cannot give both. `clock` is required, as in `@zukhruf/election` and `@zukhruf/sqlite-changefeed`, because the backstop waits on a timer. Dispose is `[Symbol.asyncDispose]`, because closing a socket server is asynchronous. The package throws its own errors, and re-exports `UnavailableError` of `@zukhruf/sqlite-open`, which opens its connections (`sqlite-data-version` ADR 0003).

## Considered Options

- **An API of our own, for example an async iterator of notifications.** A host that also runs on Postgres learns two APIs, and pg-boss's notifier cannot be ported line by line.
- **The commands as SQL, `database.exec("NOTIFY jobs, 'email'")`.** SQLite has no such statement, and `node:sqlite` has no hook to add one.
- **Postgres's API and contract, with `pg`'s types.** This option was selected.

## Consequences

- A host reads the Postgres docs for each line of the contract. The README states each line, the stronger one and the one not given.
- A notification of this package and one of `pg` have the same shape, so code that handles one handles the other.
- `processId` names a program, not an instance. An instance that must drop only its own notifications cannot do it by `processId` when its program has two instances on one file.
- A host that needs its own error class translates at its boundary, and keeps the package's error as `cause`.
