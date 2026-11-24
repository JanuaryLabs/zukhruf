# @zukhruf/sqlite-notify

The code follows this paper. Windows is not run.

Open:

- A socket file with no row. A listener that is killed after it served its socket and before its registration committed leaves a file that no row names. Nobody removes it. A sweep of the socket folder at the start of a listener could remove it, but a sweep can meet a socket that is bound and not yet listening.
- No test proves two rules that depend only on timing: the owed wake (research 20e R3), and a dispose while a hung listener's socket buffer is full. Their code is in `src/wakes.ts`.
- One interface for this package and for Postgres. Ticket 11 says the pool uses one interface for the notify on one computer and for `LISTEN` / `NOTIFY` across computers. That interface can live here, in the pool, or in a package of its own.

Postgres has `LISTEN` and `NOTIFY`. A session listens on a channel. Another session sends a notification with a payload, in a transaction. When that transaction commits, each listening session gets the notification. SQLite has nothing like it: a commit in one program does not tell another program. This package gives `LISTEN` and `NOTIFY` for one SQLite file, among the programs of one computer.

A notification is a row in a table of the same file, written in the sender's own transaction. Postgres calls this table the notification queue. After the commit, the sender writes a wake to each listening program, over a socket that the listener serves. The wake says only "read the queue". Each listener also checks the file every second, so a lost wake costs at most one second.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md). The research and the tickets named here are in the pool map, `.scratch/one-pool-for-the-computer/` at the workspace root, which git does not track.

## Use it

This project is an experiment. It uses `node:sqlite`, and [`@zukhruf/pipes`](../../pipes/README.md) on `node:net`.

```sh
npm install @zukhruf/sqlite-notify
```

```ts
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type Notification, Notifications } from '@zukhruf/sqlite-notify';
import { WriteAheadLog, open } from '@zukhruf/sqlite-open';
import { transaction } from '@zukhruf/sqlite-transaction';

await using scratch = await mkdtempDisposable(join(tmpdir(), 'notify-'));
const path = join(scratch.path, 'app.sqlite');

// The listener. In real use it is another program on the same file.
await using listener = new Notifications({ path, clock: globalThis });
listener.on('error', (error) => console.error(error));
const heard = Promise.withResolvers<Notification>();
listener.on('notification', heard.resolve);
await listener.listen('jobs');

// The sender writes a job and its notification in one transaction.
using database = open(path, {
  journal: new WriteAheadLog({ synchronous: 'full' }),
});
await using sender = new Notifications({ database, clock: globalThis });
sender.on('error', (error) => console.error(error));
database.exec('CREATE TABLE jobs (name TEXT NOT NULL) STRICT');
transaction(
  database,
  () => {
    database.prepare('INSERT INTO jobs VALUES (?)').run('email');
    sender.notify('jobs', 'email');
  },
  { mode: 'immediate' },
);

const notification = await heard.promise;
console.log(notification.channel, notification.payload);
console.log(notification.processId === process.pid);
```

Output:

```
jobs email
true
```

## The API

```ts
import type { EventEmitter } from 'node:events';
import type { DatabaseSync } from 'node:sqlite';

import type { Clock } from '@zukhruf/async';

export class Notifications
  extends EventEmitter<{ notification: [Notification]; error: [unknown] }>
  implements AsyncDisposable
{
  constructor(options: NotificationsOptions);
  listen(channel: string): Promise<void>;
  unlisten(channel: string): Promise<void>;
  notify(channel: string, payload?: string): void;
  [Symbol.asyncDispose](): Promise<void>;
}

export type NotificationsOptions = FileOptions | ConnectionOptions;

export interface FileOptions {
  path: string;
  database?: never;
  clock: Clock;
  maxQueuedNotifications?: number;
}

export interface ConnectionOptions {
  database: DatabaseSync;
  path?: never;
  clock: Clock;
  maxQueuedNotifications?: number;
}

/** The `Notification` of `pg` (node-postgres): the same fields and types. */
export interface Notification {
  processId: number;
  channel: string;
  payload: string;
}

export class QueueFullError extends Error {
  readonly code: '54000';
}

export class DisposedError extends Error {}

export {
  DeniedError,
  MissingError,
  UnavailableError,
} from '@zukhruf/sqlite-open';
export { UnsafeFolderError } from '@zukhruf/pipes';
```

## The rules

- `new Notifications({ path })` owns its connection to the file. It opens it with `open(path, { journal: new WriteAheadLog({ synchronous: 'full' }) })` of `@zukhruf/sqlite-open`, as `@zukhruf/sqlite-queue` does, and closes it at dispose.
- `new Notifications({ database })` sends on a `DatabaseSync` that the caller opened. The caller closes it. A database in memory has no file that another program can open, so the constructor throws a `TypeError`.
- The constructor makes the tables, if they are missing, on the sending connection. On a file that a later release made, it changes nothing. See [The tables](#the-tables).
- `clock` is required. The backstop waits on it. Give `globalThis` in production, and a fake clock in a test ([`@zukhruf/async`](../../async/README.md#run-a-wait-on-a-clock)).
- `notify(channel, payload)` is synchronous. When the sending connection is in a transaction, it inserts the row in that transaction. When it is not, it inserts the row in a `BEGIN IMMEDIATE` transaction of its own. `payload` is `''` when you give none, as in Postgres.
- The wakes go out on the next microtask. A transaction of the family is synchronous ("`work` must be synchronous", [`@zukhruf/sqlite-transaction`](../transaction/README.md)), so by then the transaction has committed or rolled back. After a rollback, the wake finds no row, and the listener gives nothing to its caller. [ADR 0004](./docs/adr/0004-the-wake-goes-out-after-the-synchronous-transaction.md) tells why.
- A transaction that stays open across an `await` breaks the rule above. Its wake then comes before its commit and finds nothing. The backstop finds the row up to one second later.
- `listen(channel)` resolves when the registration has committed. Each notification that commits after that comes to `notification`. A notification that committed before it does not come. Read the state that you need after `listen` resolves, then rely on the notifications. This is Postgres's rule for the start.
- `unlisten(channel)` stops the notifications of that channel at once. The last `unlisten` removes the listener's row, closes its socket and closes the listener's own connection. The next `listen` is a first `listen` again: it gets a new listener id and a new socket. `listen` and `unlisten` of a channel that is already in that state do nothing, as in Postgres. There is no `UNLISTEN *`: dispose ends every channel.
- Each listening `Notifications` serves its own socket: a Unix socket on macOS and Linux, a named pipe on Windows. Nothing serves for a program that only sends. [ADR 0003](./docs/adr/0003-no-hub-each-listener-serves-its-own-socket.md) tells why.
- The listener reads the queue on its own connection to the file, outside any transaction. It opens that connection at the first `listen` and never sets its journal.
- Each second, the listener reads `PRAGMA data_version` on its own connection, and reads the queue when it changed. This is the backstop. It finds a row whose wake was lost. The backstop also writes the listener's position, with a busy timeout of 0: `node:sqlite` is synchronous, so a write that waits for the lock would stop the event loop of the listener. A write that finds the file busy fails at once, and the next backstop tries again.
- A dead listener is one whose connect rejected with `NoServerError` of [`@zukhruf/pipes`](../../pipes/README.md#errors), or that closed the sender's connection. `NoServerError` has the cause `ECONNREFUSED` (a socket file that a killed listener left), `ENOENT` (no file), `ENOTSOCK` (macOS, a file that is not a socket) or `ECONNRESET` (Linux, a listener that closed during the connect) (#5317). On macOS a live listener whose listen queue is full refuses a connect with `ECONNREFUSED` too, so outside Linux an `ECONNREFUSED` makes a listener dead only when its presence is free or missing: each listener holds a `FileLock` of [`@zukhruf/fs`](../../fs/README.md) on `<database>.listeners/<listener id>.presence` from before its row is inserted until after its row is removed. A listener of an older release has no presence file, and counts as dead. A live one's refused wake goes to `error`, and the next send connects again ([ADR 0011](./docs/adr/0011-a-refused-connect-removes-a-listener-only-when-its-presence-is-free.md)). The sender's next transaction removes a dead listener's rows. When that transaction is the sender's own, the sender then removes its socket file, and its presence file under its lock; on Windows there is no socket file to remove. A removal in the caller's transaction commits or rolls back with it, and `node:sqlite` does not tell when that transaction ends. On the next microtask the caller's transaction has ended, so the sender reads whether the rows are still there: rows gone, it removes the socket file and the presence file; rows still there, the caller rolled back, and the next `notify` removes them again ([ADR 0010](./docs/adr/0010-the-trim-wakes-the-laggard-and-a-dead-listener-is-forgotten-once-its-rows-are-gone.md)). Another connect error goes to `error`, and the next send connects again.
- At its trim, a sender also wakes the laggards: the listeners at the lowest position, when it is below the highest id, whatever their channels. Postgres's `SignalBackends` wakes the listeners that are far behind for the same reason: the tail can then move. A live laggard reads. A dead one refuses the connect, and the sender removes its rows. A hung one accepts the connect and keeps its row, as in Postgres (C10). See [ADR 0010](./docs/adr/0010-the-trim-wakes-the-laggard-and-a-dead-listener-is-forgotten-once-its-rows-are-gone.md).
- `maxQueuedNotifications` is the number of rows above the lowest position that the queue holds: the highest id minus the lowest position. It counts the rows of every channel. Its default is `1_048_576`: a Postgres queue at its default holds at least that many notifications of the largest payload, one for each page ([ADR 0005](./docs/adr/0005-a-row-stays-until-each-listener-read-it.md)). When `notify` finds that many rows or more, it throws `QueueFullError`. The count uses the position, not the last id, so a row that a listener has read counts until the backstop writes its position, up to one second later (test "C10: a full queue fails the sender program with QueueFullError", `src/queue.test.ts`). With no listener, there is no position, and no count.
- A sender that listens on the channel gets its own notification, as in Postgres. `processId` is the `process.pid` of the sending program. Compare it with `process.pid` to drop your own. Two instances in one program have the same `processId`.
- Notifications come in the order of their commits. Inside one transaction, they come in the order of the `notify` calls.
- A listener for `error` is necessary. A failure that no caller awaits, for example a failed read after a wake, goes to the `error` event. With no listener, `EventEmitter` throws. A `notification` listener that throws sends its error to `error`, and the next notifications of the read still come.
- Dispose with `await using`, or call `[Symbol.asyncDispose]()`. It writes the wakes that are due, ends the connections to other listeners, removes this listener's rows, closes its socket and closes the connections that it opened.
- A notification is durable. It survives the crash of its sender and of any other program, because it is a row of the file. Postgres loses its queue in a crash of the server.
- A program never opens, reads, copies or watches the database file with `fs`. On POSIX, the close of any descriptor of a file drops every SQLite lock that the program holds on it ([`@zukhruf/fs`](../../fs/README.md)).
- Windows is not proven. The named pipe is the one of `@zukhruf/pipes`. Its proof is backlog #4340, and nothing waits for it.

## The contract

The 13 lines of Postgres's contract (research 19 §1), and how this package keeps each one.

| #   | Postgres                                                              | Here                                                                                                                                                                                |
| --- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Each session that listens on the channel gets it, in any program.     | The same, for each program of the computer, and of the same user, on the same file.                                                                                                 |
| C2  | Only at commit. A rollback sends nothing.                             | The same. The row rolls back with the transaction, and a wake that finds no row gives nothing ([ADR 0004](./docs/adr/0004-the-wake-goes-out-after-the-synchronous-transaction.md)). |
| C3  | Only sessions that listen at that moment.                             | The same. A channel delivers only rows above the highest id at the commit of its `listen`.                                                                                          |
| C4  | A listener in a transaction gets it after the transaction.            | The same. Notifications come on the event loop, and a transaction of the family never spans a turn of it.                                                                           |
| C5  | The channel, the sender's process id and the payload.                 | The same fields, as `pg` gives them. `processId` is the sending program's `process.pid`.                                                                                            |
| C6  | The payload is shorter than 8000 bytes.                               | The same, in UTF-8 bytes.                                                                                                                                                           |
| C7  | Identical notifications of one transaction are delivered once.        | **Not given.** Each `notify` is one notification ([ADR 0006](./docs/adr/0006-identical-notifications-of-one-transaction-are-not-folded.md)).                                        |
| C8  | The order of the sends, then the order of the commits.                | The same. The ids are in commit order.                                                                                                                                              |
| C9  | A sender that listens hears itself.                                   | The same.                                                                                                                                                                           |
| C10 | A full queue fails the sender at commit.                              | The same effect: `notify` throws `QueueFullError`, so its transaction does not commit ([ADR 0005](./docs/adr/0005-a-row-stays-until-each-listener-read-it.md)).                     |
| C11 | A session that ends loses its registrations.                          | The same. Dispose removes them. A crashed listener's row stays until the next trim of a sender, on any channel, finds it dead.                                                      |
| C12 | A crash of the server loses the queue.                                | **Stronger.** The queue is a table of the file, and a crash loses no committed notification.                                                                                        |
| C13 | Commit the `LISTEN`, then read the state, then rely on notifications. | The same. `listen` resolves after its commit.                                                                                                                                       |

## What each call does

| Call or event                   | Rows                                                                                                                                                                                                                                                                                                                                                                                                        | Socket                                                                                                                                                   | Wakes                                                                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Notifications(options)`    | Reads the recorded release with no lock. Makes the missing tables on the sending connection, and records this release, unless the file records a later release, or this release and fits.                                                                                                                                                                                                                   | None.                                                                                                                                                    | None.                                                                                                                                          |
| The first `listen(channel)`     | Opens the listener's own connection, and takes its presence. One `BEGIN IMMEDIATE` transaction inserts the listener row with its address, reads the highest id as its position, and inserts the channel row.                                                                                                                                                                                                | Makes the socket folder and the presence folder if they are missing, locks a new presence file, and serves a new socket.                                 | None. The backstop starts.                                                                                                                     |
| A later `listen(channel)`       | One `BEGIN IMMEDIATE` transaction inserts the channel row and reads the highest id.                                                                                                                                                                                                                                                                                                                         | None.                                                                                                                                                    | None.                                                                                                                                          |
| `notify(channel, payload)`      | In the current transaction, or in its own: removes the rows of the listeners that this sender found dead, fails when the queue is full, inserts the row, reads the addresses on the channel, and trims at most 10,000 rows at most once a second. A trim also reads the laggards.                                                                                                                           | None.                                                                                                                                                    | On the next microtask: one wake to each address read, and to each laggard. It connects to an address the first time, and keeps the connection. |
| A wake comes in                 | Reads the rows above the listener's last id on its own connection, outside a transaction, and emits the rows of its channels.                                                                                                                                                                                                                                                                               | None.                                                                                                                                                    | None.                                                                                                                                          |
| Each second (the backstop)      | Reads `PRAGMA data_version`, and reads the queue when it changed. Writes the listener's position when it moved; the write has a busy timeout of 0, and a write that finds the file busy waits for the next second.                                                                                                                                                                                          | None.                                                                                                                                                    | None.                                                                                                                                          |
| A refused connect, or a `close` | `NoServerError` at the connect (cause `ECONNREFUSED`, `ENOENT`, `ENOTSOCK` or `ECONNRESET`), or a `close`: the sender's next transaction removes that listener's rows. Outside Linux, an `ECONNREFUSED` whose presence is locked is a lost wake instead, and goes to `error`. A removal in the caller's transaction is done again in each `notify`, until a read on the next microtask finds the rows gone. | The sender removes that socket file once the removal of the row has committed, and the presence file under its lock; on Windows there is no socket file. | That address gets no more wakes.                                                                                                               |
| A wake while one is in flight   | None.                                                                                                                                                                                                                                                                                                                                                                                                       | None.                                                                                                                                                    | The connection owes one wake, and writes it when the first one is flushed. A second wake while one is owed adds nothing.                       |
| `unlisten(channel)`             | Removes the channel row. The last one also removes the listener row, and closes the listener's connection.                                                                                                                                                                                                                                                                                                  | The last one closes the socket, which removes its file, and then deletes the presence file and frees it.                                                 | None.                                                                                                                                          |
| `[Symbol.asyncDispose]()`       | Removes this listener's rows.                                                                                                                                                                                                                                                                                                                                                                               | Closes its socket, deletes its presence file and frees it, and ends its connections to other listeners.                                                  | Writes the wakes that are due first.                                                                                                           |

## The tables

The tables are a `Declaration` of [`@zukhruf/sqlite-drift`](../drift) with `rows: 'keep'`, as in `@zukhruf/sqlite-queue`. A new release changes a `CREATE` statement, and the constructor rebuilds the table and keeps its rows. No release writes a migration.

- The file records the version of the release that last applied the tables, in `zukhruf_notify_version`. The version comes from the `package.json` of the package: no person keeps a number ([ADR 0009](./docs/adr/0009-the-file-records-the-release-that-made-its-tables-and-an-older-release-leaves-them-alone.md)).
- A release that constructs on a file of a later release changes nothing. A column that a release adds must be nullable or have a default, so that an older release can write the row.
- A file that records a later release, or records this release and fits, takes no write lock at construction.

```sql
CREATE TABLE zukhruf_notify_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  payload TEXT NOT NULL,
  process_id INTEGER NOT NULL
) STRICT;

CREATE TABLE zukhruf_notify_listener (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL,
  process_id INTEGER NOT NULL
) STRICT;

CREATE INDEX zukhruf_notify_listener_position ON zukhruf_notify_listener (position);

CREATE TABLE zukhruf_notify_channel (
  channel TEXT NOT NULL,
  listener TEXT NOT NULL,
  PRIMARY KEY (channel, listener)
) STRICT, WITHOUT ROWID;

CREATE TABLE zukhruf_notify_version (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version TEXT NOT NULL
) STRICT;
```

- `AUTOINCREMENT` is required. A plain `INTEGER PRIMARY KEY` gives the ids of trimmed rows again, and a listener whose last id is higher never reads the new rows (research 20b T2).
- The highest id is the `seq` of the queue in `sqlite_sequence`, so it stays right when the trim removed every row.
- The names start with `zukhruf_notify_`, as pg-boss's tables start with `pgboss_` and Solid Cable's with `solid_cable_`. SQLite keeps names that start with `sqlite_` for itself.
- No foreign key: a caller's connection can have `foreign_keys` off. The package removes the channel rows of a listener in the same transaction as its listener row.

## The socket folder

[`@zukhruf/pipes`](../../pipes/README.md) gives the socket address. Each listener gets `new PipeEndpoint(<listener id>, { prefix: 'zukhruf-sqlite-notify' })`, and the listener id is 16 random bytes in hex. The package gives:

- On macOS and Linux, the socket `/tmp/zukhruf-sqlite-notify-<uid>/<listener id>`. `<uid>` is `process.getuid()`. The path is at most 70 bytes, under the limit of 103 bytes on macOS and 107 on Linux.
- The folder, made with mode `0700`. When it exists, it must be a folder, not a link, owned by this user, with no access for its group or others. Otherwise `listen` throws the `UnsafeFolderError` of `@zukhruf/pipes`. tmux has the same rule for `/tmp/tmux-<uid>` ([ADR 0007](./docs/adr/0007-the-socket-folder-is-short-and-belongs-to-one-user.md)).
- On Windows, the named pipe `\\.\pipe\zukhruf-sqlite-notify-<listener id>`. Windows removes a pipe when its program exits.
- The listen, and the removal of the socket file when the socket closes.

What stays in this package:

- The listener id, and the address in the listener row: `endpoint.address.path`. A sender connects to the address that it read, with `new PipeAddress(address).connect()`.
- Another user cannot connect to a socket that Node makes with the default mode (research 20a P5). Pools are per user, so this is the rule, not a limit.
- A listener's socket file and presence file stay after a crash. The sender that finds the listener dead removes them once the removal of the row has committed.

## Errors

| Error               | When                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnavailableError`  | The file is missing, or the system denies access to it. It is the class of `@zukhruf/sqlite-open`, which opens the connections: a `MissingError` or a `DeniedError` when the system says which. `cause` is the error of SQLite. |
| `QueueFullError`    | `notify` finds `maxQueuedNotifications` rows that a listener has not read. Its message and `code` are Postgres's: `too many notifications in the NOTIFY queue`, `54000`. The transaction of the call does not commit.           |
| `UnsafeFolderError` | `listen` finds a socket folder that is not a folder, is a link, belongs to another user, or gives access to its group or others. `path` is the folder. It is the class of `@zukhruf/pipes`, which makes the folder.             |
| `RangeError`        | A channel or a payload that Postgres refuses, with Postgres's message: `channel name cannot be empty`, `channel name too long` (64 bytes or more), `payload string too long` (8000 bytes or more).                              |
| `DisposedError`     | `listen`, `unlisten` or `notify` after dispose. .NET throws `ObjectDisposedException` for a call on a disposed object. A second dispose resolves.                                                                               |
| `TypeError`         | `database` is a database in memory.                                                                                                                                                                                             |
| The error of SQLite | All other failures, for example `database is locked` when the busy timeout ends.                                                                                                                                                |

The package throws its own errors. A host that needs its own error translates at its boundary, and keeps the error of the package as `cause`.

## Who uses it

| Consumer                | How                                                                                                                                                                                                                                                             | Record                |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `@zukhruf/sqlite-queue` | `useListenNotify` across instances. A send wakes the workers of each `SqliteJobQueue` on the same file, as a `pg_notify` wakes each pg-boss listener on the schema. The poll of pg-boss stays as the backstop. The README line that states the divergence goes. | backlog #4334         |
| `@zukhruf/pool`         | Two channels for each pool: "a new job" (the owner listens, the payload is the revision of the job) and "an output" (each sending host listens, the payload is the job id).                                                                                     | map tickets 11 and 20 |

## The same concepts in other systems

| System                                                                             | What it does                                                                                                                                                             |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Postgres `LISTEN` / `NOTIFY`](https://www.postgresql.org/docs/18/sql-notify.html) | The contract that this package copies. The sender writes a shared queue before its commit, and signals each listening session after it (`src/backend/commands/async.c`). |
| [`pg`](https://node-postgres.com/) (node-postgres)                                 | Gives a notification as a `notification` event of its `Client`, with `processId`, `channel` and `payload`. This package gives the same event and the same fields.        |
| [honker](https://github.com/russellromney/honker)                                  | `notify` is an insert into a table, in the sender's transaction. One native thread polls `PRAGMA data_version` every 1 ms. The caller trims the table.                   |
| [Rails Solid Cable](https://github.com/rails/solid_cable)                          | A message is a row. A listener polls for rows above its last id every 0.1 s. A job trims rows after one day.                                                             |
| Android Room `enableMultiInstanceInvalidation`                                     | Tells the other processes of an app which tables changed, through a service that each process connects to.                                                               |
| Apple Core Data remote change notifications                                        | Posts a notification for each write to a SQLite store, also a write by another process.                                                                                  |
| SQLite `PRAGMA data_version`                                                       | Changes when another connection commits. The backstop reads it.                                                                                                          |

## Documentation

- [0001 Postgres's LISTEN and NOTIFY on one SQLite file](./docs/adr/0001-postgres-listen-and-notify-on-one-sqlite-file.md)
- [0002 The queue is the truth and the wake is a hint](./docs/adr/0002-the-queue-is-the-truth-and-the-wake-is-a-hint.md)
- [0003 No hub: each listener serves its own socket](./docs/adr/0003-no-hub-each-listener-serves-its-own-socket.md)
- [0004 The wake goes out after the synchronous transaction](./docs/adr/0004-the-wake-goes-out-after-the-synchronous-transaction.md)
- [0005 A row stays until each listener read it](./docs/adr/0005-a-row-stays-until-each-listener-read-it.md)
- [0006 Identical notifications of one transaction are not folded](./docs/adr/0006-identical-notifications-of-one-transaction-are-not-folded.md)
- [0007 The socket folder is short and belongs to one user](./docs/adr/0007-the-socket-folder-is-short-and-belongs-to-one-user.md)
- [0008 The socket address is the third place, so its extraction comes first](./docs/adr/0008-the-socket-address-is-the-third-place-so-its-extraction-comes-first.md)
- [0010 The trim wakes the laggard, and a dead listener is forgotten once its rows are gone](./docs/adr/0010-the-trim-wakes-the-laggard-and-a-dead-listener-is-forgotten-once-its-rows-are-gone.md)
- [0011 A refused connect removes a listener only when its presence is free](./docs/adr/0011-a-refused-connect-removes-a-listener-only-when-its-presence-is-free.md)
