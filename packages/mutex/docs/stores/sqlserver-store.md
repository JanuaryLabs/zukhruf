# SqlServerStore

A network lock store that keeps a lease row in a SQL Server table for each key. Each process on each machine that reaches one SQL Server database shares the keys. The holder renews its row, and the lease ends `leaseDuration` after the last renewal, on the server's clock. Thus a holder that stops, also with no goodbye, loses its key after about `leaseDuration`.

| Reach   | Order                                                                   | Holder stops                                     | Token source          |
| ------- | ----------------------------------------------------------------------- | ------------------------------------------------ | --------------------- |
| Network | First come, first served in one process; the next try between processes | Its lease ends `leaseDuration` after its renewal | A SQL Server sequence |

## What

Each key has one row in a table that you create. A grant writes a random holder ID, a new fencing token and the server's time into the row. The holder writes the server's time again each `heartbeatInterval` milliseconds. Another store takes the key when the row has no holder, or when `leaseDuration` milliseconds passed since the last renewal on the server's clock. To release the key, the holder clears the holder ID of its row. The store does not import a SQL Server driver. You give it a `connect` function, and the store gets a session from that function for each statement ([ADR 0022](../adr/0022-a-database-lock-store-takes-its-session-from-the-caller.md)). The session must be connected when `connect` resolves: a holder's lease counts from the moment the store has the session, right before its statement goes to the server, so a session that connects in its first query spends that connect from the lease.

No driver object fits the session as it is. A `Connection` of [tedious](https://tediousjs.github.io/tedious/) has `on('error')` and `close()`, so your wrapper adds only `query`:

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
    options: { database: 'app' },
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
    table: 'dbo.app_leases',
    sequence: 'dbo.app_lock_tokens',
    heartbeatInterval: 5_000,
    clock: globalThis,
  }),
);
```

## Why

The host lock stores share a lock only between processes on one machine. When your app runs on many machines, they must ask one place for each key. Many apps already have a SQL Server database. See [ADR 0021](../adr/0021-a-lock-store-can-reach-every-machine-that-reaches-one-server.md).

A lock that lives on a session ends only when the server learns that the session ended. A holder that vanishes tells the server nothing. Behind the gateway of Azure SQL Database with the Proxy connection policy, the server talks to the gateway, not to the client, so it does not see the client go. In production, a session lock of a container that an App Service slot swap stopped stayed for 51 minutes. A lease that ends unless its holder renews it does not depend on the server's view of the session. The server's clock decides the end, so every store uses one clock, and one `tryAcquire` can take a lease that ended. See [ADR 0035](../adr/0035-a-sql-server-key-is-a-lease-that-ends-unless-its-holder-renews-it.md).

## When

- Processes on more than one machine write to the resource.
- These processes already reach one SQL Server database.
- Holder processes can crash or vanish, and you want no manual cleanup.
- A wait of up to `leaseDuration` for the key of a holder that vanished is acceptable.

## When not

- All callers are on one host. A [host lock store](../concepts/reach.md) needs no server and no round trip.
- A waiter must get the key at once after a release. A waiter in another process sees a release only at its next try, at most `heartbeatInterval` later.
- The order between processes must be first come, first served. Each waiter tries on its own interval, and the first try after a release wins.

## How it works

**The table.** You create one table for the leases, one time, before the app starts, for example in a migration. The store runs no DDL:

```sql
CREATE TABLE dbo.app_leases (
  name binary(16) NOT NULL PRIMARY KEY,
  holder uniqueidentifier NULL,
  token bigint NOT NULL,
  renewed datetime2 NOT NULL,
  duration int NOT NULL
);
GRANT SELECT, INSERT, UPDATE ON OBJECT::dbo.app_leases TO app_role;
```

Each column has one job:

- `name`: the key. The store calculates the SHA-256 digest of the UTF-16 code units of the key (`Buffer.from(key, 'utf16le')`), as `PostgresStore` does, and keeps the first 16 bytes. Thus a key of any length fits, and the name is the same on each machine and in each version.
- `holder`: a random UUID for each grant, or `NULL` when the key is free.
- `token`: the fencing token of the last grant.
- `renewed`: the server's time (`SYSUTCDATETIME()`) of the grant or of the last renewal.
- `duration`: the `leaseDuration` of the holder, in milliseconds. The holder writes it, so the stores of one key can have different values, and the row tells each store when the lease ends.

`OBJECT_ID` finds the table and the sequence by name, with or without a schema, and `QUOTENAME` quotes them. A name cannot be a parameter of a statement.

**A grant.** One compare and set, in one batch:

```sql
UPDATE <table>
SET holder = @holder, token = NEXT VALUE FOR <sequence>, renewed = SYSUTCDATETIME(), duration = @duration
OUTPUT inserted.token INTO @granted
WHERE name = @name AND (holder IS NULL OR DATEADD(millisecond, duration, renewed) <= SYSUTCDATETIME());
```

When the statement changes no row and the key has no row, the batch adds the row with the same values. Of two stores that add the row of one key at the same time, the second gets a duplicate key (error 2627, or 2601 for a unique index), the batch catches only these two errors, and the store gets no grant. A grant is the token that `OUTPUT` gives. The token comes from the sequence in the same statement, so a later grant always has a larger token.

**The heartbeat.** Each `heartbeatInterval` milliseconds, the holder renews its row: `UPDATE <table> SET renewed = SYSUTCDATETIME() WHERE name = @name AND holder = @holder`. A renewal that changes no row means that another store took the key after the lease ended. The store then aborts the signal of the lease with `LeaseLostError` ([ADR 0013](../adr/0013-a-lost-lease-aborts-the-signal-of-the-lease.md)). A renewal that fails, or that gets no answer before two intervals passed since the statement of the last renewal that succeeded went to the server, also aborts the signal. The holder counts on its `clock`, from the moment it sends the statement, after its session is there: the server writes `renewed` when it runs the statement, which is later, so the holder stops before the lease can end. The first count starts when the grant statement goes to the server (#5973). `leaseDuration` is larger than two intervals, so the holder stops before another store can take its key, when the two clocks run at the same rate.

**A wait.** Callers in one process first line up in a queue in memory, in the order of their calls. Only the first caller in that queue tries the key. If the key is busy, that caller tries again each `heartbeatInterval` milliseconds on its `clock`, until a grant. The other callers of this process wait in the queue. The server keeps no queue.

**A cancel.** A caller cancels its wait with a signal. The call rejects with `signal.reason` at once. If a try was running, and the server granted the key to it, the store releases that grant when its answer arrives.

**A release.** The holder runs `UPDATE <table> SET holder = NULL WHERE name = @name AND holder = @holder`. When it changes no row, another store took the key after the lease ended, and the store aborts the signal of the lease with `LeaseLostError`. Then the next caller in the in-process queue continues. A waiter in another process gets the key at its next try.

**The token.** The tokens come from one SQL Server sequence that you name with `sequence`, for example `dbo.app_lock_tokens`. Create it one time before the app starts, and give the role of the app `UPDATE` on it:

```sql
CREATE SEQUENCE dbo.app_lock_tokens AS bigint START WITH 1 NO CACHE;
GRANT UPDATE ON OBJECT::dbo.app_lock_tokens TO app_role;
```

SQL Server keeps one counter for each sequence in the server, so the numbers come in the order of the calls, also with a cache. With a cache, SQL Server writes the numbers to disk in blocks. An unexpected stop of the server loses the numbers of the block that were not used. The next numbers are still larger, so only gaps occur. `NO CACHE` writes each number to disk. Gaps between tokens are normal.

### Sessions

The store gets a session from `connect` for each statement, and closes it when the statement ends: a grant, a renewal, a release, or a holder check. Thus a wait or a held key keeps no session open on the server, and a session can come from a pool: `close()` can give the connection back to its pool. A session can also connect again by itself, as an mssql `ConnectionPool` does: the lease is in the row, not on the session. A new connection for each statement costs one login on the server. With a `heartbeatInterval` of 5 seconds, a holder costs one login each 5 seconds.

The store attaches an `error` listener to each session, because a driver can emit `error` after the close, and an `error` with no listener stops the process.

## Acquire modes

`tryAcquire` gives up at once if another caller in this process holds or waits for the key. Otherwise it runs the grant one time. If the grant changes no row, the call gives `undefined`. A lease that ended is free, so one `tryAcquire` takes the key of a holder that vanished. A waiter that gives up leaves the in-process queue. See [acquire modes](../concepts/acquire-modes.md).

## Holder check

`isHeld(key)` reads the row: the key is held when `holder` is not `NULL` and the lease did not end on the server's clock. It changes nothing, so it never acquires the key ([ADR 0015](../adr/0015-a-holder-check-never-acquires-the-key.md)). It needs only `SELECT` on the table. The holder can change before the answer arrives. Show the answer, but do not acquire a key because of it.

## Failure modes

- **A holder process stops, also with no goodbye:** its row stays until the lease ends, `leaseDuration` after its last renewal. Then the next try of a waiter gets the key. Thus a vanished holder costs at most `leaseDuration` plus one `heartbeatInterval` of the waiter, whatever the network between the holder and the server does: a gateway, a proxy, or a machine that stopped with no reset.
- **The server or the network is slow or stops answering while a holder runs:** the renewal fails or is late, and the store aborts the signal of the lease within two intervals. The row stays until the lease ends, so no other store can take the key before the holder stops. A holder that lost its lease does not clear its row.
- **A session ends while the holder runs:** nothing changes. The lease does not live on a session, and the next renewal uses a new session. Causes: the network drops the connection, `KILL`, and a restart or failover of the server.
- **A holder freezes:** its renewals stop. Another store takes the key when the lease ended. The frozen holder sees the lost lease only when it runs again, at its next renewal. A [fenced resource](../concepts/fencing-tokens.md) refuses its late writes.
- **The wall clock of the server jumps forward:** leases end early, and another store can take a key while its holder still works. The fencing token is the protection for that case.
- **The table or the sequence does not exist, or the role has no permission on it:** the statement fails with `The table <name> does not exist, or the role has no permission on it.` or `The sequence <name> does not exist, or the role has no permission on it.`, and the call rejects.
- **The tokens after a failover:** with a cache, a new primary can start after the last block that was written to disk. We did not test this. Use `NO CACHE` if your fenced resource must never see a smaller token.

See [failure modes](../concepts/failure-modes.md).

## Options

| Option              | Default | Description                                                                                                                                                                                                                                                           |
| ------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect`           | —       | A function that gives a session. A session has `query(text, parameters)`, `on('error')`, and `close()`. The store runs one statement on each session, and then closes it.                                                                                             |
| `table`             | —       | The name of an existing table for the leases, with or without its schema. Create it before the app starts; the store runs no DDL. See [How it works](#how-it-works).                                                                                                  |
| `sequence`          | —       | The name of an existing sequence for the fencing tokens, with or without its schema. Create it before the app starts; the store runs no DDL.                                                                                                                          |
| `heartbeatInterval` | —       | Milliseconds between two renewals of a holder, and between two tries of a waiter. A holder whose renewals fail for two intervals stops: its signal aborts.                                                                                                            |
| `leaseDuration`     | 30,000  | Milliseconds after its last renewal, on the server's clock, at which the lease of a holder ends and another store can take the key. The constructor throws a `RangeError` when it is not larger than two heartbeat intervals.                                         |
| `clock`             | —       | The clock of the heartbeat and of the tries. Give `globalThis` in production; a test gives a fake clock, for example `createClock()` of `@sinonjs/fake-timers` ([`@zukhruf/async`](../../../async/README.md#run-a-wait-on-a-clock)). The server's clock ends a lease. |

## Evidence

Each design error and each rule of the lease has a test in [`src/lock-stores/sqlserver/sqlserver-store.test.ts`](../../src/lock-stores/sqlserver/sqlserver-store.test.ts). The name of the test says what the wrong design broke:

- **A waiter gets the key of a holder that vanished with no close, though the server never sees the session end** ([`sqlserver-store.vanished-holder.test.ts`](../../src/lock-stores/sqlserver/sqlserver-store.vanished-holder.test.ts)). A TCP hop between the holder and the server stops forwarding and keeps its connections to the server open, as the gateway of Azure SQL does. Wrong design: a session lock, which the server keeps while the session lasts.
- **A holder that stops renewing loses its key to a waiter leaseDuration after its last renewal, on the clock of the server.** Wrong design: an end that does not count from the last renewal.
- **A holder whose key another store took loses its lease at its next renewal.** Wrong design: a renewal that does not compare the holder.
- **The release of a holder whose key another store took leaves the key with the new holder.** Wrong design: a release that does not compare the holder.
- **Of stores that race for a key with no row, one gets the key and the others get no error**, under locking read committed and under read committed snapshot. Wrong design: an insert that does not catch the duplicate key.
- **Of stores that race for a free key, one gets the key**, under both isolation levels. Wrong design: a read of the row, and then a write.
- **A key is free for another store as soon as its release resolves.** Wrong design: a release that does not wait for the server.
- **Two keys that differ only after 255 characters are two locks.** Wrong design: the key itself as the name.
- **The store refuses a lease duration that is not larger than two heartbeat intervals.** Wrong design: a holder that can work after another store took its key.

The contract tests of a lock store run in [`sqlserver-store.contract.test.ts`](../../src/lock-stores/sqlserver/sqlserver-store.contract.test.ts): two stores never hold one key at the same time, a waiter gets the key after the release, `tryAcquire` gives up on a held key, the holder check answers `true` and `false`, the tokens increase across stores and processes, a killed holder process or thread does not block the next caller, and a held key is lost two heartbeat intervals after the server stops answering.

These facts come from probes of the statements on SQL Server 2022 (16.0.4325.4) with tedious 20. [ADR 0035](../adr/0035-a-sql-server-key-is-a-lease-that-ends-unless-its-holder-renews-it.md#probes) gives the details:

- **`NEXT VALUE FOR` works in the `UPDATE` and in the `INSERT` of the grant.** An `UPDATE` that changes no row takes no number from the sequence.
- **The server's clock ends the lease.** With a duration of 1,000 ms, a try 700 ms after a renewal got no grant, and a try 1,100 ms after it got the key.
- **One grant in each race.** 16 sessions raced 200 times for a key with no row and 200 times for a released row, under locking read committed and under read committed snapshot. Each race had exactly one grant and no error.
- **The grants that the role needs.** `SELECT`, `INSERT` and `UPDATE` on the table, and `UPDATE` on the sequence. With less, the call rejects with the message of the missing object.
