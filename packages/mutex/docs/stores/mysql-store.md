# MysqlStore

A network lock store that uses a MySQL user lock (`GET_LOCK`) as the lock. Each process on each machine that reaches one MySQL database shares the locks. The server releases the lock when the session of the holder ends.

| Reach   | Order                                                                                 | Holder stops                   | Token source                           |
| ------- | ------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------- |
| Network | First come, first served in one process; the order of MySQL's lock queue between them | Released when its session ends | A table with one row, in your database |

## What

Each held key has one session: one connection to the MySQL server. The session holds a user lock on a name that the store makes from the key. To release the key, the session runs `RELEASE_LOCK`. The store does not import a MySQL driver. You give it a `connect` function, and the store gets each session from that function ([ADR 0022](../adr/0022-a-database-lock-store-takes-its-session-from-the-caller.md)).

```ts
import mysql from 'mysql2/promise';

import { Mutex } from '@zukhruf/mutex';
import { MysqlStore } from '@zukhruf/mutex/mysql';

const pool = mysql.createPool({
  uri: process.env.DATABASE_URL,
  enableKeepAlive: true,
  keepAliveInitialDelay: 10_000,
});

const mutex = new Mutex(
  new MysqlStore({
    connect: () => pool.getConnection(),
    table: 'app_lock_tokens',
    heartbeatInterval: 5_000,
  }),
);
```

For MariaDB, use [MariadbStore](./mariadb-store.md). The two stores share one design. They differ in the time limit of a wait, in the token source, and in the driver.

## Why

The host lock stores share a lock only between processes on one machine. When your app runs on many machines, they must ask one place for each key. Many apps already have a MySQL server, and MySQL has user locks. The server keeps each user lock while its session lasts. It releases the lock when the session ends, also when the client disconnects without a goodbye. Thus no caller must find or remove a holder that stopped. See [ADR 0021](../adr/0021-a-lock-store-can-reach-every-machine-that-reaches-one-server.md).

## When

- Processes on more than one machine write to the resource.
- These processes already reach one MySQL server.
- Holder processes can crash, and you want no manual cleanup.

## When not

- All callers are on one host. A [host lock store](../concepts/reach.md) needs no server and no round trip.
- Your sessions go through a proxy that gives one server connection to many clients, for example ProxySQL with connection multiplexing. See [Failure modes](#failure-modes).
- You cannot let the store hold one session for each key that is held or waited for. See [Sessions and the pool](#sessions-and-the-pool).

## How it works

**The name of a key.** A user lock belongs to the whole server, but the token source belongs to one database. Thus the server makes the name from the database of the session and the key: `SHA2(CONCAT(DATABASE(), ':', ?), 256)` ([ADR 0025](../adr/0025-a-mysql-family-lock-belongs-to-one-database.md)). The client sends `?`: the SHA-256 digest of the UTF-16 code units of the key (`Buffer.from(key, 'utf16le')`), as 64 lowercase hex characters. UTF-16 code units, not UTF-8, so that two keys that differ only in a lone surrogate get two digests. `GET_LOCK` takes a name of at most 64 characters, and MySQL compares names without case. The name has 64 lowercase hex characters, so each key fits, and two keys that differ only in case get two names. Two keys in one database get the same name only if SHA-256 collides. Below, `<name>` is this expression.

Two stores in two databases on one server never share a key. Each one has its own token source, and a shared lock with two token sources could give a later holder a smaller token. A session with no database makes the name `NULL`, and each lock function then fails with `ER_USER_LOCK_WRONG_NAME`.

**One session for each held key.** MySQL grants a user lock again to a session that already holds it. The locks stack, and each lock needs its own `RELEASE_LOCK`. Thus a session that holds a key never asks for a second key, and a second caller of a key never uses the session of the holder.

1. Callers in one process first line up in a queue in memory, in the order of their calls. Only the first caller in that queue continues to the next step. Thus one process uses at most one session for each key, however many callers wait.
2. That caller gets a session from `connect`. The store attaches its own `error` and `end` listeners at once.
3. The session runs `SELECT /*+ SET_VAR(max_execution_time = 0) */ GET_LOCK(<name>, -1)`. A negative timeout waits with no limit. The hint stops the `max_execution_time` of the session for this statement only, because that limit interrupts a waiting `GET_LOCK`. The query waits in MySQL's lock queue until the server grants the lock. The store does not poll.
4. After the grant, the session runs the token update. See [The token](#the-token).
5. While the key is held, the session asks each `heartbeatInterval` milliseconds whether it still holds the lock. See [The heartbeat](#the-heartbeat).
6. To release the key, the session runs `SELECT RELEASE_LOCK(<name>)`. If the result is `1`, the store gives the session back with `release()`. Then the next caller in the in-process queue continues.

**A cancel.** A caller cancels its wait with a signal. The store then closes the waiting session with `destroy()`, and the call rejects with `signal.reason` at once. The store needs no second session ([ADR 0023](../adr/0023-a-postgres-waiter-is-cancelled-by-closing-its-session.md)). If the server grants the lock just before the close, the end of the session releases it.

Unlike Postgres, MySQL finds a closed waiter while it waits. `destroy()` of mysql2 closes only the side of the client. The server sees the close within about one second, ends the wait, and leaves no phantom waiter. The query of a closed session can still give a late result, also a grant. The store reads the signal, not that result.

### The heartbeat

A holder must know when its session ends. A session that ends with a reset or a close emits `error` or `end`. But a network that stops silently sends nothing. Thus the session of each holder runs `SELECT IS_USED_LOCK(<name>) = CONNECTION_ID()` each `heartbeatInterval` milliseconds. The heartbeat asks about the lock, not about the connection. A session that connects again by itself answers a query, but it does not hold the lock. If the query fails, if the result is not `1`, or if no answer arrives within `heartbeatInterval`, the store aborts the signal of the lease with `LeaseLostError` and closes the session. `IS_USED_LOCK` never acquires the lock.

`heartbeatInterval` is the longest time that a holder can work after its session ended, before its signal aborts. Until then, only the [fencing token](../concepts/fencing-tokens.md) protects the resource.

### The token

MySQL has no sequence. The store uses the method of the MySQL manual for `LAST_INSERT_ID(expr)`: a table with one row. The store runs no DDL. Create the table one time before the app starts, for example in a migration. Give the user of the app `SELECT` and `UPDATE` on it:

```sql
CREATE TABLE app_lock_tokens (id BIGINT UNSIGNED NOT NULL);
INSERT INTO app_lock_tokens VALUES (0);
GRANT SELECT, UPDATE ON app.app_lock_tokens TO 'app'@'%';
```

The column must be `id`. After each grant, the session runs:

```sql
UPDATE `app_lock_tokens` SET id = LAST_INSERT_ID(id + 1);
SELECT CAST(LAST_INSERT_ID() AS CHAR) AS token, ROW_COUNT() AS updated;
```

The `UPDATE` locks the row, so two sessions never get one number. `LAST_INSERT_ID()` belongs to the session, so another session cannot change it between the two statements. A later grant always runs the update later, so it gets a larger number. The number is a committed row, so a restart keeps it.

The update must change exactly one row. If the table has no row, the update changes nothing, and `LAST_INSERT_ID()` keeps the last token of the session. A pooled session keeps that value for the next borrower. Thus the store checks `ROW_COUNT()`, and a result other than `1` fails the grant and releases the key. Do not delete the row.

### Sessions and the pool

The store keeps a session for each key that this process holds or waits for. A holder check gets one more session for one query. A cancel needs no session. If the pool has no free session, `connect` waits.

A session that holds nothing goes back to the pool with `release()`, and the store first removes its `error` and `end` listeners. A session whose lock state is not known is closed with `destroy()`. A plain `release()` of mysql2 keeps the user locks on the session, so the next borrower would hold the key (see [Evidence](#evidence)).

## Acquire modes

`tryAcquire` gives up at once if another caller in this process holds or waits for the key. Otherwise it gets a session and runs `SELECT GET_LOCK(<name>, 0)` once. If the result is `0`, the session holds nothing, so the store gives it back with `release()`. A waiter that gives up closes its session as a cancel does, or leaves the in-process queue. See [acquire modes](../concepts/acquire-modes.md).

## Holder check

`isHeld(key)` gets a session, runs `SELECT IS_USED_LOCK(<name>), DATABASE()`, and gives the session back. If `DATABASE()` is `NULL`, the call fails. `IS_USED_LOCK` gives the connection ID of the holder, or `NULL`. It never acquires the key ([ADR 0015](../adr/0015-a-holder-check-never-acquires-the-key.md)). A waiter is not a holder. The holder can change before the answer arrives. Show the answer, but do not acquire a key because of it.

## Failure modes

- **A holder process stops:** its kernel closes the connection. The server ends the session and releases the key. The next waiter gets the key.
- **A session ends while the holder runs:** the server releases the key at once, and another holder can get it. Causes: the network drops the connection, `KILL`, `wait_timeout`, and a restart of the server. The session emits `end`, and sometimes `error` before it. The store then aborts the signal of the lease with `LeaseLostError` one time ([ADR 0013](../adr/0013-a-lost-lease-aborts-the-signal-of-the-lease.md)).
- **The server restarts, or a replica is promoted:** each session ends, so each key is released and each holder gets a lost lease. A replica holds none of the user locks of the source.
- **A silent partition:** the network stops and sends no reset. The [heartbeat](#the-heartbeat) finds it within `heartbeatInterval`, and the signal of the lease aborts. A waiting session has no heartbeat: set `enableKeepAlive: true` and `keepAliveInitialDelay` on the pool (the example uses `10_000`), so that TCP keep-alive finds a dead connection of a waiter.
- **A holder machine stops with no reset:** the server sees the end of the session only through TCP keep-alive. Until then, the key stays held, and waiters wait.
- **A holder freezes:** waiters wait. If the server ends the session meanwhile, another holder can get the key. The frozen holder sees the lost lease only when it runs again. A [fenced resource](../concepts/fencing-tokens.md) refuses its late writes.
- **A proxy that multiplexes connections:** not supported. The proxy can send the statements of one client to two server connections. Then the lock and its release can run on two sessions. Connect to MySQL directly, or turn multiplexing off for the sessions of the store.
- **A reset of a session:** `COM_RESET_CONNECTION` and `RELEASE_ALL_LOCKS()` release each user lock of the session. Do not run them on a session that the store holds.
- **The database of a held session changes:** for example with `USE`. The release then makes another name and releases nothing. The store sees the failed release, aborts the signal of the lease, and closes the session. The server then releases the lock. Do not change the database of a session that the store holds.
- **A session with no database:** each call fails with `ER_USER_LOCK_WRONG_NAME`. Give the pool a database.
- **The token table has no row, or more than one row:** each grant fails with `The token table ... must have exactly one row`, and the call rejects. The store releases the key.
- **The token table does not exist:** the first grant fails with the error of MySQL, and the call rejects. The store releases the key.

See [failure modes](../concepts/failure-modes.md).

## Options

| Option              | Default | Description                                                                                                                                                                                                         |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect`           | —       | A function that gives a new session. `pool.getConnection` of mysql2 fits. A session has `query(sql, values)`, `on('error' \| 'end')`, `off`, `release()` and `destroy()`. The store owns each session that it gets. |
| `table`             | —       | The name of an existing table in the database of the session, with one row and one `BIGINT UNSIGNED` column `id`. Create it before the app starts; the store runs no DDL.                                           |
| `heartbeatInterval` | —       | Milliseconds between two heartbeats of a holder, and the time limit of each heartbeat. It is the longest time that a holder can work after its session ended, before its signal aborts.                             |

All three options are required. No option has a default.

## Evidence

Each design error that the probes found has a test in [`src/lock-stores/mysql/mysql-store.test.ts`](../../src/lock-stores/mysql/mysql-store.test.ts). The name of the test says what the wrong design broke:

- **A held key is lost within heartbeatInterval when the server stops answering.** Wrong design: no heartbeat.
- **A killed session loses its lease before the next heartbeat.** The heartbeat is 10 seconds away. Wrong design: no `error` and `end` listeners.
- **A session that reconnects silently loses its lease.** The session of the holder hides the end of its connection after `KILL`, and connects again. Wrong design: a heartbeat that asks about the connection (`SELECT 1`), not the lock.
- **The next acquire after a cancel gets the only session of the pool at once.** The pool has one session. Wrong design: a cancel that gets a second session from the pool.
- **A cancelled waiter that the server grants later gives the key to the next waiter.** Wrong design: a cancel that keeps the waiting session.
- **A released key leaves no lock on the session that goes back to the pool.** Wrong design: `release()` without `RELEASE_LOCK`.
- **A wait outlasts the max_execution_time of its session.** Wrong design: a plain `GET_LOCK`.
- **A key longer than 64 characters is a lock.** Wrong design: the key as the name.
- **Keys that differ only in case are two locks.** Wrong design: the key as the name.
- **Two stores in different databases on one server do not share a key.** Wrong design: the key alone, for the whole server.
- **A token table without its row fails the acquire instead of repeating a token.** Wrong design: no check of `ROW_COUNT()`.
- **A user with only SELECT and UPDATE on the token table can acquire.** Wrong design: `CREATE TABLE IF NOT EXISTS` in the store.

The file also has the contract tests of a lock store: two stores never run two holders at once, a waiter gets the key after the release, `tryAcquire` gives up on a held key, `isHeld` tells a held key from a free key, and tokens increase.

These facts come from probes on `mysql:lts` (MySQL 9.7.4) with mysql2 3.24.5 and mariadb 3.5.4:

- **Locks stack in one session.** One session ran `GET_LOCK('k', 0)` two times and got `1` two times. Then `RELEASE_LOCK('k')` three times gave `1`, `1`, `NULL`. One session can hold many names.
- **`RELEASE_LOCK` results.** `1`: released. `0`: another session holds it. `NULL`: no session holds it.
- **Names.** A name of 65 characters failed with `User-level lock name ... should not exceed 64 characters`. A session that held `Case` made `GET_LOCK('case', 0)` of another session give `0`.
- **Timeouts.** `-1`, `-0.5`, `4294967296` and `18446744073709551615` all waited until the release. `0.3` gave `0` at once: MySQL cuts the fraction.
- **`max_execution_time` interrupts a wait.** With `max_execution_time = 300`, `GET_LOCK('t', 2)` failed after 306 ms with `ER_QUERY_TIMEOUT`. The hint `MAX_EXECUTION_TIME(0)` did not stop it. The hint `SET_VAR(max_execution_time = 0)` did. `lock_wait_timeout` had no effect.
- **The holder check.** `IS_USED_LOCK` gave the connection ID of the holder while another session waited. On a free name it gave `NULL`, and another session then got the name.
- **A user lock belongs to the server.** A session in one database held `scope`. A session in another database got `0` from `GET_LOCK('scope', 0)`. Thus the store puts the database in the name.
- **The name with the database.** `SHA2(CONCAT(DATABASE(), ':', 'abc'), 256)` gave 64 lowercase hex characters, and `GET_LOCK`, `IS_USED_LOCK` and `RELEASE_LOCK` worked with it. With no database, each of them failed with `ER_USER_LOCK_WRONG_NAME`.
- **A closed waiter leaves no phantom.** `destroy()` of mysql2 on a waiter in `GET_LOCK` settled its query about 800 ms later with `ER_QUERY_INTERRUPTED`. 300 ms after that, the waiter was not in `PROCESSLIST`. The next waiter got the key 1 ms after the release.
- **A late grant goes to a closed waiter, and the server releases it.** A waiter was closed, and the holder released at once. The closed waiter's query resolved with `1`. The next waiter got the key 1 to 2 ms later.
- **A pool release keeps the locks.** In a pool of one connection, a session got a lock and called `release()`. The next borrower had the same connection ID and held the lock. After `destroy()`, no session held it.
- **Events on `KILL`.** mysql2 emitted `error` (`PROTOCOL_CONNECTION_LOST`) one time and `end` one time on an idle session. On a session in a query, the query rejected and `end` came one time. The lock was gone at once.
- **The token.** A user with only `UPDATE` failed with `SELECT command denied ... for column 'id'`. With `SELECT, UPDATE`, it got `1`. On an empty table the update changed 0 rows, and `LAST_INSERT_ID()` gave the last token of the session again. Two sessions in turn got 3, 4, 5, 6, 7, 8. Five sessions with 100 updates in parallel got 100 different numbers.
