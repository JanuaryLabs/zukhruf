# SqlServerStore

A network lock store that uses a SQL Server application lock as the lock. Each process on each machine that reaches one SQL Server database shares the locks. The server releases the lock when the session of the holder ends.

| Reach   | Order                                                                                           | Holder stops                   | Token source          |
| ------- | ----------------------------------------------------------------------------------------------- | ------------------------------ | --------------------- |
| Network | First come, first served in one process; the order of SQL Server's lock queue between processes | Released when its session ends | A SQL Server sequence |

## What

Each held key has one session: one connection to SQL Server. The session holds an application lock of SQL Server (`sp_getapplock` with `@LockOwner = 'Session'`) on a name that the store makes from the key. To release the key, the session runs `sp_releaseapplock`, and then the store closes the session. The store does not import a SQL Server driver. You give it a `connect` function, and the store gets each session from that function ([ADR 0022](../adr/0022-a-database-lock-store-takes-its-session-from-the-caller.md)).

No driver object fits the session as it is. A `Connection` of [tedious](https://tediousjs.github.io/tedious/) has `on('error' | 'end')` and `close()`, so your wrapper adds only `query`:

```ts
import { Connection, Request, TYPES } from 'tedious';

import { Mutex } from '@zukhruf/mutex';
import {
  type SqlServerSession,
  SqlServerStore,
} from '@zukhruf/mutex/sqlserver';

async function connect(): Promise<SqlServerSession> {
  const connection = new Connection({
    server: process.env.DATABASE_HOST,
    authentication: {
      type: 'default',
      options: {
        userName: process.env.DATABASE_USER,
        password: process.env.DATABASE_PASSWORD,
      },
    },
    // A wait can be longer than the 15 seconds that tedious gives each request.
    options: { database: 'app', requestTimeout: 0 },
  });
  await new Promise<void>((resolve, reject) =>
    connection.connect((error) => (error ? reject(error) : resolve())),
  );
  return Object.assign(connection, {
    query: (text: string, parameters: Record<string, string>) =>
      new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const rows: Record<string, unknown>[] = [];
        const request = new Request(text, (error) =>
          error ? reject(error) : resolve(rows),
        );
        for (const [name, value] of Object.entries(parameters)) {
          request.addParameter(name, TYPES.NVarChar, value);
        }
        request.on(
          'row',
          (columns: { metadata: { colName: string }; value: unknown }[]) =>
            rows.push(
              Object.fromEntries(
                columns.map((column) => [
                  column.metadata.colName,
                  column.value,
                ]),
              ),
            ),
        );
        connection.execSql(request);
      }),
  });
}

const mutex = new Mutex(
  new SqlServerStore({
    connect,
    sequence: 'dbo.app_lock_tokens',
    heartbeatInterval: 5_000,
  }),
);
```

## Why

The host lock stores share a lock only between processes on one machine. When your app runs on many machines, they must ask one place for each key. Many apps already have a SQL Server database, and SQL Server has application locks. The server keeps a session-owned application lock while its session lasts. It releases the lock when the session ends, also when the client disconnects without a goodbye. Thus no caller must find or remove a holder that stopped. See [ADR 0021](../adr/0021-a-lock-store-can-reach-every-machine-that-reaches-one-server.md).

## When

- Processes on more than one machine write to the resource.
- These processes already reach one SQL Server database.
- Holder processes can crash, and you want no manual cleanup.
- The role of the app can get `VIEW SERVER STATE`, or you do not use holder checks. See [Holder check](#holder-check).

## When not

- All callers are on one host. A [host lock store](../concepts/reach.md) needs no server and no round trip.
- You can give the store only sessions that connect again by themselves, for example an mssql `ConnectionPool`. See [Failure modes](#failure-modes).
- You cannot let the store open one connection for each key that is held or waited for. See [Sessions](#sessions).

## How it works

**The name of a key.** `sp_getapplock` takes the name of the lock in `@Resource`, an `nvarchar(255)`. SQL Server cuts a longer name to 255 characters with no error, so two long keys with the same first 255 characters would be one lock (see [Evidence](#evidence)). Thus the store calculates the SHA-256 digest of the UTF-16 code units of the key (`Buffer.from(key, 'utf16le')`), as `PostgresStore` does. It uses the first 16 bytes of the digest as 32 hex characters. `sys.dm_tran_locks` shows only the first 32 characters of the name, so the [holder check](#holder-check) sees the full name. The name is the same on each machine and in each version.

**One session for each held key.** SQL Server grants an application lock again to a session that already holds it. The locks stack, and each lock needs its own release. Thus a session that holds a key never asks for a second key, and a second caller of a key never uses the session of the holder.

1. Callers in one process first line up in a queue in memory, in the order of their calls. Only the first caller in that queue continues to the next step. Thus one process uses at most one session for each key, however many callers wait.
2. That caller gets a session from `connect`. The store attaches its own `error` and `end` listeners at once.
3. The session runs `sp_getapplock` with `@LockMode = 'Exclusive'`, `@LockOwner = 'Session'` and `@LockTimeout = -1`. The batch waits in SQL Server's lock queue until the server grants the lock. The store does not poll. A result of `0` or `1` is a grant. A negative result is an error, and the call rejects.
4. After the grant, the session runs `NEXT VALUE FOR` on the sequence. The store reads the result with `BigInt` and makes the fencing token from it. A later grant always runs `NEXT VALUE FOR` later, so it gets a larger number.
5. While the key is held, the session asks `APPLOCK_MODE` each `heartbeatInterval` milliseconds whether it still holds the lock. See [The heartbeat](#the-heartbeat).
6. To release the key, the session runs `sp_releaseapplock`. If the result is `0`, the store closes the session. Then the next caller in the in-process queue continues.

The store runs `sp_releaseapplock` before the close, because the server sees a closed connection a little later than the close. In a test, another session tried the key right after a close, and the key was still busy in 2 of 30 tries (see [Evidence](#evidence)).

**A cancel.** A caller cancels its wait with a signal. The store then closes the waiting session, and the call rejects with `signal.reason` at once. The store needs no second session. SQL Server removes the waiter from its lock queue when the connection closes, so a cancelled waiter leaves no phantom waiter, as Postgres does ([ADR 0023](../adr/0023-a-postgres-waiter-is-cancelled-by-closing-its-session.md)). If the server grants the lock just before the close, the end of the session releases it.

### The heartbeat

A holder must know when its session ends. A session that ends with a reset or a close emits `end` and `error`. But a network that stops silently sends nothing. Thus the session of each holder runs `APPLOCK_MODE('public', @resource, 'Session')` each `heartbeatInterval` milliseconds. The heartbeat asks about the lock, not about the connection. A session that connects again by itself answers a query, but it does not hold the lock. If the query fails, if the mode is `NoLock`, or if no answer arrives within `heartbeatInterval`, the store aborts the signal of the lease with `LeaseLostError` and closes the session. `APPLOCK_MODE` only reads the mode of the lock, so it acquires nothing, and a heartbeat that timed out leaves no lock behind.

`heartbeatInterval` is the longest time that a holder can work after its session ended, before its signal aborts. Until then, only the [fencing token](../concepts/fencing-tokens.md) protects the resource.

**The token.** The tokens come from one SQL Server sequence that you name with `sequence`, for example `dbo.app_lock_tokens`. The store runs no DDL. Create the sequence one time before the app starts, for example in a migration, and give the role of the app `UPDATE` on it:

```sql
CREATE SEQUENCE dbo.app_lock_tokens AS bigint START WITH 1 NO CACHE;
GRANT UPDATE ON OBJECT::dbo.app_lock_tokens TO app_role;
```

`NEXT VALUE FOR` takes no parameter, so the store finds the sequence with `OBJECT_ID(@sequence, 'SO')` and quotes its schema and name with `QUOTENAME`. A name with a schema and a name without one both work. SQL Server keeps one counter for each sequence in the server, so the numbers come in the order of the calls, also with a cache. With a cache, SQL Server writes the numbers to disk in blocks. An unexpected stop of the server loses the numbers of the block that were not used. The next numbers are still larger, so only gaps occur. `NO CACHE` writes each number to disk. Gaps between tokens are normal.

### Sessions

The store keeps a session for each key that this process holds or waits for. A holder check gets one more session for one query. A cancel needs no session. The store closes each session that it gets, also after a clean release, so `connect` must give a new connection each time. A connection costs one login on the server.

A session must be one connection that never connects again by itself. An mssql `ConnectionPool` with `max: 1` is not a session. After `KILL`, its next query ran on a new connection with the same session ID, and the application lock was gone. The pool emitted no event (see [Evidence](#evidence)). Thus a holder would see the end of its session only at its next heartbeat, not at once.

## Acquire modes

`tryAcquire` gives up at once if another caller in this process holds or waits for the key. Otherwise it gets a session and runs `sp_getapplock` with `@LockTimeout = 0` once. If the result is `-1`, the session holds nothing, and the store closes it. A waiter that gives up closes its session as a cancel does, or leaves the in-process queue. See [acquire modes](../concepts/acquire-modes.md).

## Holder check

`isHeld(key)` gets a session, reads `sys.dm_tran_locks`, and closes the session. It never runs `sp_getapplock` or `APPLOCK_TEST`, so it never acquires the key ([ADR 0015](../adr/0015-a-holder-check-never-acquires-the-key.md)). `APPLOCK_TEST` takes the lock for an instant on a free key. See [ADR 0024](../adr/0024-a-sql-server-holder-check-reads-the-lock-view.md).

```sql
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM sys.dm_tran_locks
  WHERE resource_type = N'APPLICATION'
    AND resource_database_id = DB_ID()
    AND request_status = N'GRANT'
    AND LEFT(resource_description, 36) = N'0:[' + @resource + N']'
) THEN 1 ELSE 0 END AS held
```

The view shows an application lock as `<principal ID>:[<first 32 characters of the name>]:(<hash>)`. `0` is the principal ID of `public`, the principal that `sp_getapplock` uses. A waiter has a row with `request_status` equal to `WAIT`, so it does not count as a holder.

The view needs `VIEW SERVER STATE` on SQL Server 2019 and earlier, and `VIEW SERVER PERFORMANCE STATE` on SQL Server 2022. Without it, the holder check rejects with error 300. `acquire` and `tryAcquire` do not need it. The holder can change before the answer arrives. Show the answer, but do not acquire a key because of it.

## Failure modes

- **A holder process stops:** its kernel closes the connection. The server ends the session and releases the key. The next waiter gets the key.
- **A session ends while the holder runs:** the server releases the key at once, and another holder can get it. Causes: the network drops the connection, `KILL`, and a restart or failover of the server. The session emits `end` and `error`. The store then aborts the signal of the lease with `LeaseLostError` ([ADR 0013](../adr/0013-a-lost-lease-aborts-the-signal-of-the-lease.md)). The lease is lost only one time.
- **The server restarts, or an availability group fails over:** each session ends, so each key is released and each holder gets a lost lease.
- **A silent partition:** the network stops and sends no reset. The server can release the key, and the holder does not see the end of its session. The [heartbeat](#the-heartbeat) finds it within `heartbeatInterval`, and the signal of the lease aborts. Until then, only the [fencing token](../concepts/fencing-tokens.md) protects the resource. A waiting session has no heartbeat. tedious turns on TCP keep-alive with an idle time of 30 seconds (`KEEP_ALIVE_INITIAL_DELAY` in `tedious/lib/connection.js`), so the operating system finds a dead connection of a waiter after that time and its probes.
- **A holder machine stops with no reset:** the server sees the end of the session only through its own TCP keep-alive. Until then, the key stays held, and waiters wait.
- **A holder freezes:** waiters wait. If the server ends the session meanwhile, another holder can get the key. The frozen holder sees the lost lease only when it runs again. A [fenced resource](../concepts/fencing-tokens.md) refuses its late writes.
- **A session that connects again by itself:** not supported. The new connection does not hold the lock. The next [heartbeat](#the-heartbeat) finds that the session holds no lock, and the signal of the lease aborts. Until then, the holder has a lease on a key that is free. See [Sessions](#sessions).
- **The request timeout of the driver:** tedious stops each request after `requestTimeout`, 15 seconds by default. Then a wait rejects with `ETIMEOUT`, and the call rejects. Set `requestTimeout: 0` on the connections that `connect` gives. The server removes a waiter that timed out from its lock queue, so the timeout leaves no lock behind.
- **The sequence does not exist, or the role has no permission on it:** the first grant fails with `The sequence <name> does not exist, or the role has no permission on it.`, and the call rejects. The store releases the key when it cannot make the token.
- **The tokens after a failover:** with a cache, a new primary can start after the last block that was written to disk. We did not test this. Use `NO CACHE` if your fenced resource must never see a smaller token.

See [failure modes](../concepts/failure-modes.md).

## Options

| Option              | Default | Description                                                                                                                                                                                                                   |
| ------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect`           | —       | A function that gives a new session: one connection that never connects again by itself. A session has `query(text, parameters)`, `on('error' \| 'end')`, and `close()`. The store owns and closes each session that it gets. |
| `sequence`          | —       | The name of an existing sequence for the fencing tokens, with or without its schema. Create it before the app starts; the store runs no DDL.                                                                                  |
| `heartbeatInterval` | —       | Milliseconds between two heartbeats of a holder, and the time limit of each heartbeat. It is the longest time that a holder can work after its session ended, before its signal aborts.                                       |

All three options are required. No option has a default.

## Evidence

Each design error that the review found has a test in [`src/lock-stores/sqlserver/sqlserver-store.test.ts`](../../src/lock-stores/sqlserver/sqlserver-store.test.ts). The name of the test says what the wrong design broke:

- **A key is free for another store as soon as its release resolves.** In 200 rounds, a store releases a key, and another store with an open session tries it at once. Wrong design: a release that only closes the session.
- **A cancelled waiter that the server grants later gives the key to the next waiter.** After the holder releases, a caller in another store gets the key. Wrong design: a cancel that does not close the waiting session.
- **Two keys that differ only after 255 characters are two locks.** Wrong design: the key itself as the name of the lock.
- **A held key is lost within heartbeatInterval when the server stops answering.** A TCP proxy stops forwarding and closes no socket. The signal of the lease aborts with `LeaseLostError` within two intervals. Wrong design: no heartbeat.
- **A held key is lost at once when the server kills its session.** `KILL` ends the session of the holder, and the heartbeat is 30 seconds away. Wrong design: no `end` or `error` listener.
- **A session that reconnects silently loses its lease.** The session of the holder hides the end of its connection after `KILL`, and connects again, as an mssql `ConnectionPool` does. The signal of the lease aborts within two intervals. Wrong design: a heartbeat that asks about the connection (`SELECT 1`), not the lock.

The same file has the contract tests of a lock store: two stores never hold one key at the same time, a waiter gets the key after the release, `tryAcquire` gives up on a held key, the holder check answers `true` and `false`, the tokens increase across stores, and a cancelled acquire rejects with the reason of its signal.

These facts come from probes before the design. Each probe used tedious 20.3.3 and mssql 12.7.4. The server was Azure SQL Edge 15.0.2000 (ARM64), except where the item says SQL Server 2022 (16.0.4305, x64):

- **Locks stack in one session.** One session ran `sp_getapplock` two times, and each result was `0`. After one `sp_releaseapplock`, another session still got `-1` with `@LockTimeout = 0`. After the second, it got `0`. A third release failed with error 1223 (`Cannot release the application lock ... because it is not currently held`).
- **A long name is cut with no error.** `sp_getapplock` with a name of 256 characters succeeded.
- **`APPLOCK_TEST` acquires the lock for an instant** (also on SQL Server 2022). An Extended Events session recorded `lock_acquired` with mode `X` on the `APPLICATION` resource for each `APPLOCK_TEST` on a free key, and no event on a held key. In 166,170 calls of `APPLOCK_TEST` from 12 sessions, 3,784 tries of the free key by another session never got `-1`. `APPLOCK_TEST` also answers `1` (free) in the session of the holder.
- **`sys.dm_tran_locks` shows the first 32 characters of the name.** A lock on a 64-character name showed as `0:[<first 32 characters>]:(81b4e65e)`, with a `GRANT` row for the holder and a `WAIT` row for the waiter. A user without `VIEW SERVER STATE` got error 300. On SQL Server 2022, `VIEW SERVER PERFORMANCE STATE` was enough.
- **A closed waiter leaves the lock queue.** A waiter in `sp_getapplock` was closed. Its request rejected at once with `Connection closed before request completed.` 200 ms later, `sys.dm_tran_locks` showed only the holder, and `sys.dm_exec_sessions` did not show the session. After the release, the next waiter got the key 1 ms later. In 20 races of a release and a close, the next waiter always got the key.
- **A release by close alone leaves the key busy for a short time.** In 30 rounds, after the `end` event of the closed holder, another open session got `-1` from `sp_getapplock` with `@LockTimeout = 0` 2 times.
- **An ended session emits its events.** After `KILL`, the tedious connection emitted `end` and then `error` (`ESOCKET`, `Connection lost - socket hang up`), each one time. Its next request failed with `EINVALIDSTATE`. Another session got the key at once.
- **The request timeout of tedious cancels the wait on the server.** A waiter with `requestTimeout: 500` rejected with `ETIMEOUT`. `sys.dm_tran_locks` then showed only the holder, and after the release another session got the key.
- **An mssql `ConnectionPool` connects again silently.** In a pool with `max: 1`, the session 53 acquired a lock and was killed. The next query ran with `@@SPID` 53 again, and `APPLOCK_MODE` answered `NoLock`. The pool emitted no `error`.
- **The sequence gives numbers in the order of the calls.** With `CACHE 50`, two sessions called `NEXT VALUE FOR` in turn and got 1 to 6. tedious returned a `bigint` as a string.
- **`UPDATE` on the sequence is enough** (also on SQL Server 2022). A user with no permission got `NULL` from `OBJECT_ID`. After `GRANT UPDATE ON OBJECT::dbo.mutex_tokens`, the token batch worked with `mutex_tokens` and with `dbo.mutex_tokens`. The same user could not run `CREATE SEQUENCE`, and `sp_getapplock` needed no grant.
