# MariadbStore

A network lock store that uses a MariaDB user lock (`GET_LOCK`) as the lock. Each process on each machine that reaches one MariaDB database shares the locks. The server releases the lock when the session of the holder ends.

| Reach   | Order                                                                                   | Holder stops                   | Token source       |
| ------- | --------------------------------------------------------------------------------------- | ------------------------------ | ------------------ |
| Network | First come, first served in one process; the order of MariaDB's lock queue between them | Released when its session ends | A MariaDB sequence |

## What

Each held key has one session: one connection to the MariaDB server. The session holds a user lock on a name that the store makes from the key. To release the key, the session runs `RELEASE_LOCK`. The store does not import a MariaDB driver. You give it a `connect` function, and the store gets each session from that function ([ADR 0022](../adr/0022-a-database-lock-store-takes-its-session-from-the-caller.md)).

```ts
import mariadb from 'mariadb';

import { Mutex } from '@zukhruf/mutex';
import { MariadbStore } from '@zukhruf/mutex/mariadb';

const pool = mariadb.createPool({
  host: process.env.DATABASE_HOST,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: 'app',
  keepAliveDelay: 10_000,
});

const mutex = new Mutex(
  new MariadbStore({
    connect: () => pool.getConnection(),
    sequence: 'app_lock_tokens',
    heartbeatInterval: 5_000,
  }),
);
```

`MariadbStore` has the design of [MysqlStore](./mysql-store.md). Read that page for the parts that are the same: one session for each held key, the heartbeat, the pool, and the holder check. This page tells the differences.

## Why

The host lock stores share a lock only between processes on one machine. Many apps that run on many machines already have a MariaDB server, and MariaDB has user locks. The server releases a user lock when its session ends. Thus no caller must find or remove a holder that stopped. See [ADR 0021](../adr/0021-a-lock-store-can-reach-every-machine-that-reaches-one-server.md).

## When

- Processes on more than one machine write to the resource.
- These processes already reach one MariaDB server.
- Holder processes can crash, and you want no manual cleanup.

## When not

- All callers are on one host. A [host lock store](../concepts/reach.md) needs no server and no round trip.
- Your sessions go through MaxScale or another proxy that sends the statements of one client to more than one server connection.
- You use a Galera cluster. Galera does not replicate user locks, so two nodes can grant one key.
- You cannot let the store hold one session for each key that is held or waited for.

## How it works

The steps are the steps of [MysqlStore](./mysql-store.md#how-it-works). These parts are different:

**The name of a key.** The store uses the same name as MysqlStore: `SHA2(CONCAT(DATABASE(), ':', ?), 256)`, where `?` is the SHA-256 digest of the UTF-16 code units of the key. Below, `<name>` is this expression. Thus a lock belongs to one database, as its sequence does ([ADR 0025](../adr/0025-a-mysql-family-lock-belongs-to-one-database.md)). MariaDB takes names of up to 192 characters and compares them with case. The name has 64 lowercase hex characters, so it fits. A session with no database makes the name `NULL`. MariaDB then gives `NULL` with no error, and the store fails the call.

**The wait.** The session runs `SET STATEMENT max_statement_time = 0 FOR SELECT GET_LOCK(<name>, 31536000)`.

- MariaDB has no timeout that waits with no limit. A negative timeout gives `NULL` at once, with warning 1411 `Incorrect timeout value`. A timeout that ends after 2^64 nanoseconds since 1970 gives `0` at once. Thus the store uses one year, 31,536,000 seconds. If one year passes, `GET_LOCK` gives `0`, and the session waits again at the end of the queue.
- The `max_statement_time` of a session makes a waiting `GET_LOCK` give `NULL`, with no error. `SET STATEMENT` stops that limit for this statement only. The store treats each `NULL` from `GET_LOCK` as an error.

**A cancel.** The store closes the waiting session with `destroy()`, and the call rejects with `signal.reason` at once. The mariadb driver then opens a new connection outside the pool and runs `KILL` on the waiting session. That connection uses one connection slot of the server for a short time. A grant just before the close goes to the closed session, and the `KILL` releases it.

**The token.** The tokens come from one MariaDB sequence that you name with `sequence`. The store runs no DDL. Create the sequence one time before the app starts, and give the user of the app `SELECT` and `INSERT` on it:

```sql
CREATE SEQUENCE app_lock_tokens;
GRANT SELECT, INSERT ON app.app_lock_tokens TO 'app'@'%';
```

After each grant, the session runs `SELECT CAST(NEXTVAL(app_lock_tokens) AS CHAR) AS token`. The store reads the result with `BigInt`. `NEXTVAL` gives each session a different number. A later grant always runs `NEXTVAL` later, so it gets a larger number. The cache of a sequence (1000 numbers by default) belongs to the server, not to a session, so the numbers follow the order of the calls. A restart skips the numbers of the cache that were not used. It does not give them again. Gaps between tokens are normal.

**The pool.** A plain `release()` keeps the user locks on the session, as in MysqlStore. The pool option `resetAfterUse: true` of the mariadb driver resets the session at each release, and that also releases its user locks. The store does not depend on that option: it releases the lock first, and it destroys each session whose lock state is not known. `release()` of the mariadb driver returns a promise that never rejects.

## Acquire modes

`tryAcquire` runs `SELECT GET_LOCK(<name>, 0)` once, as in MysqlStore. See [acquire modes](../concepts/acquire-modes.md).

## Holder check

`isHeld(key)` runs `SELECT IS_USED_LOCK(<name>)` on a short session, as in MysqlStore. It never acquires the key ([ADR 0015](../adr/0015-a-holder-check-never-acquires-the-key.md)).

## Failure modes

The failure modes of [MysqlStore](./mysql-store.md#failure-modes) apply, except the ones of the token table. These are different:

- **A session ends while the holder runs:** the mariadb driver emits `error` (`ER_SOCKET_UNEXPECTED_CLOSE`) one time and `end` one time. The store aborts the signal of the lease with `LeaseLostError` one time.
- **The sequence does not exist:** the first grant fails with `Unknown SEQUENCE`, and the call rejects. The store releases the key.
- **The name is a table, not a sequence:** the first grant fails with `... is not a SEQUENCE`, and the call rejects. The store releases the key.
- **A user without `INSERT` or without `SELECT` on the sequence:** each grant fails with `INSERT command denied` or `SELECT command denied`. The store releases the key.
- **The tokens after a failover:** a replica that becomes the primary continues the sequence from the replicated value. We did not test this.

## Options

| Option              | Default | Description                                                                                                                                                                                                                     |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect`           | —       | A function that gives a new session. `pool.getConnection` of the mariadb driver fits. A session has `query(sql, values)`, `on('error' \| 'end')`, `off`, `release()` and `destroy()`. The store owns each session that it gets. |
| `sequence`          | —       | The name of an existing sequence in the database of the session, for the fencing tokens. Create it before the app starts; the store runs no DDL.                                                                                |
| `heartbeatInterval` | —       | Milliseconds between two heartbeats of a holder, and the time limit of each heartbeat. It is the longest time that a holder can work after its session ended, before its signal aborts.                                         |

All three options are required. No option has a default.

## Evidence

Each design error that the probes found has a test in [`src/lock-stores/mariadb/mariadb-store.test.ts`](../../src/lock-stores/mariadb/mariadb-store.test.ts). The tests that MysqlStore also has keep their names. These tests are for MariaDB only:

- **A wait outlasts the max_statement_time of its session.** Wrong design: a plain `GET_LOCK`, which gives `NULL` at the limit.
- **A key longer than 192 characters is a lock.** Wrong design: the key as the name.
- **Two stores in different databases on one server do not share a key.** Wrong design: the key alone, for the whole server.
- **A user with only SELECT and INSERT on the sequence can acquire.** Wrong design: `CREATE SEQUENCE IF NOT EXISTS` in the store.
- **A waiter gets the key when the holder releases it.** This contract test also fails with MySQL's timeout `-1`, which gives `NULL` on MariaDB.

These facts come from probes on `mariadb:lts` (MariaDB 12.3.3) with mysql2 3.24.5 and mariadb 3.5.4:

- **Locks stack in one session,** and `RELEASE_LOCK` gives `1`, `0` or `NULL`, as on MySQL.
- **Names.** A name of 192 characters worked, and 193 failed with `ER_TOO_LONG_IDENT`. A session that held `Case` did not stop another session from getting `case`.
- **Timeouts.** `-1` and `NULL` gave `NULL` with warning 1411. `-0.5` gave `0` at once. `31536000`, `4294967295` and `16653991012` waited until the release. `16653991013` and larger gave `0` at once: 2^64 nanoseconds minus the time since 1970, on the day of the probe. `0.3` waited 305 ms and gave `0`.
- **`max_statement_time` ends a wait with `NULL`.** With `max_statement_time = 0.3`, `GET_LOCK('t', 2)` gave `NULL` after 302 ms, with no error. With `SET STATEMENT max_statement_time = 0 FOR`, it waited the full timeout.
- **A user lock belongs to the server.** A session in one database held `scope`. A session in another database got `0`. Thus the store puts the database in the name.
- **The name with the database.** `SHA2(CONCAT(DATABASE(), ':', 'abc'), 256)` gave 64 lowercase hex characters, and the lock functions worked with it. With no database, `GET_LOCK`, `IS_USED_LOCK` and `RELEASE_LOCK` each gave `NULL`, with no error.
- **A closed waiter leaves no phantom.** `destroy()` of the mariadb driver rejected the waiting query after 3 to 4 ms with `ER_CMD_NOT_EXECUTED_DESTROYED` (`Connection destroyed, command was killed`). The next waiter got the key 2 ms after the release.
- **A late grant goes to a closed waiter, and the `KILL` releases it.** A waiter was closed, and the holder released at once. `IS_USED_LOCK` then showed the closed waiter as the holder. The next waiter got the key 1 ms later.
- **A pool release keeps the locks.** With the default options, the next borrower of the one connection of the pool held the lock. With `resetAfterUse: true`, it did not.
- **Events on `KILL`.** On an idle session and on a session in a query, the mariadb driver emitted `error` one time and `end` one time.
- **The token.** A user with only `SELECT` failed with `INSERT command denied`; with only `INSERT`, `SELECT command denied`. With both, `NEXTVAL` worked. Two sessions in turn got 1, 2, 3, 4, 5, 6 from a sequence with the default cache of 1000, and also from a sequence with `NOCACHE`.
