# PostgresStore

A network lock store that uses a Postgres advisory lock as the lock. Each process on each machine that reaches one Postgres database shares the locks. The server releases the lock when the session of the holder ends.

This page is a design. The code does not exist yet.

| Reach   | Order                                                                                        | Holder stops                   | Token source        |
| ------- | -------------------------------------------------------------------------------------------- | ------------------------------ | ------------------- |
| Network | First come, first served in one process; the order of Postgres' lock queue between processes | Released when its session ends | A Postgres sequence |

## What

Each held key has one session: one connection to the Postgres server. The session holds a session-level advisory lock on a number that the store makes from the key. To release the key, the session unlocks that number. The store does not import a Postgres driver. You give it a `connect` function, and the store gets each session from that function ([ADR 0022](../adr/0022-a-database-lock-store-takes-its-session-from-the-caller.md)).

```ts
import pg from 'pg';

import { Mutex } from '@zukhruf/mutex';
import { PostgresStore } from '@zukhruf/mutex/postgres';

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
});

const mutex = new Mutex(
  new PostgresStore({
    connect: () => pool.connect(),
    sequence: 'app_lock_tokens',
    heartbeatInterval: 5_000,
  }),
);
```

## Why

The host lock stores share a lock only between processes on one machine. When your app runs on many machines, they must ask one place for each key. Many apps already have a Postgres database, and Postgres has advisory locks. The server keeps each advisory lock while its session lasts, and it releases the lock when the session ends, also when the client disconnects without a goodbye. Thus no caller must find or remove a holder that stopped. See [ADR 0021](../adr/0021-a-lock-store-can-reach-every-machine-that-reaches-one-server.md).

## When

- Processes on more than one machine write to the resource.
- These processes already reach one Postgres database.
- Holder processes can crash, and you want no manual cleanup.

## When not

- All callers are on one host. A [host lock store](../concepts/reach.md) needs no server and no round trip.
- Your sessions go through PgBouncer in transaction pooling or statement pooling. See [Failure modes](#failure-modes).
- You cannot let the store hold one session for each key that is held or waited for. See [Sessions and the pool](#sessions-and-the-pool).

## How it works

**The number of a key.** An advisory lock takes a 64-bit integer, not a text. The store calculates the SHA-256 digest of the key. It reads the first 8 bytes of the digest as a signed 64-bit big-endian integer (`readBigInt64BE(0)` of Node.js). It hashes the key alone, with no prefix. It sends that integer as text and casts it in SQL (`$1::bigint`), because a JavaScript `number` cannot hold 64 bits. The store does not use `hashtextextended`: it is an internal Postgres function, and its result can change between major versions. DistributedLock also hashes on the client: its `allowHashing` option cuts a SHA-1 digest to 8 bytes.

Two keys can get the same number. Then they are one lock: one key waits for the other. This is false contention, not two holders, because two keys never share a session. Other software that uses advisory locks in the same database uses the same numbers.

**One session for each held key.** Postgres grants a lock again to a session that already holds it. The locks stack, and each lock needs its own unlock. Thus a session that holds a key never asks for a second key, and a second caller of a key never uses the session of the holder.

1. Callers in one process first line up in a queue in memory, in the order of their calls. Only the first caller in that queue continues to the next step. Thus one process uses at most one session for each key, however many callers wait.
2. That caller gets a session from `connect`. The store attaches its own `error` and `end` listeners at once.
3. The session sets `statement_timeout` and `lock_timeout` to `0`. Thus a timeout of the pool does not stop the wait.
4. The session runs `SELECT pg_advisory_lock($1::bigint)`. The query waits in Postgres' lock queue until the server grants the lock. The store does not poll.
5. After the grant, the session runs `SELECT nextval(<sequence>)`. The store reads the result with `BigInt` and makes the fencing token from it. A later grant always runs `nextval` later, so it gets a larger number.
6. While the key is held, the session runs `SELECT 1` each `heartbeatInterval` milliseconds. See [The heartbeat](#the-heartbeat).
7. To release the key, the session runs `SELECT pg_advisory_unlock($1::bigint)`. If the result is `true`, the session resets `statement_timeout` and `lock_timeout`, and the store gives it back with `release()`. Thus the pool gets its own settings back. Then the next caller in the in-process queue continues.

**A cancel.** A caller cancels its wait with a signal. The store then closes the waiting session with `release(true)`, and the call rejects with `signal.reason` at once. The store needs no second session. If the server grants the lock just before the close, the end of the session releases it.

The server does not see the close at once. Its process for that session stays in the lock queue until the key is free, as a phantom waiter. The phantom waiter uses one connection slot of the server. When the holder releases the key, the server finds the closed connection, ends the phantom waiter, and the next waiter gets the key. Set the server setting `client_connection_check_interval` to end a phantom waiter sooner: the server then checks the connection of each running query at that interval. Its default `0` turns the check off. See [ADR 0023](../adr/0023-a-postgres-waiter-is-cancelled-by-closing-its-session.md).

### The heartbeat

A holder must know when its session ends. A session that ends with a reset or a close emits `error` or `end`. But a network that stops silently sends nothing. TCP keep-alive with `keepAlive: true` of node-postgres waits for the idle time of the operating system first, approximately 2 hours on Linux. Thus the session of each holder runs `SELECT 1` each `heartbeatInterval` milliseconds. If the query fails, or no answer arrives within `heartbeatInterval`, the store aborts the signal of the lease with `LeaseLostError` and destroys the session. A late `SELECT 1` acquires nothing, so a heartbeat that timed out leaves no lock behind.

`heartbeatInterval` is the longest time that a holder can work after its session ended, before its signal aborts. Until then, only the [fencing token](../concepts/fencing-tokens.md) protects the resource.

**The token.** The tokens come from one Postgres sequence that you name with `sequence`. The store runs no DDL. Create the sequence one time before the app starts, for example in a migration, and give the role of the app `USAGE` on it:

```sql
CREATE SEQUENCE app_lock_tokens AS bigint CACHE 1;
GRANT USAGE ON SEQUENCE app_lock_tokens TO app_role;
```

A `CREATE SEQUENCE IF NOT EXISTS` in the store would fail for a role without `CREATE` on the schema, also when the sequence exists (see [Evidence](#evidence)). `nextval` gives each session a different number, also when many sessions call it at the same time. A sequence with `CACHE 1` gives the numbers in the order of the calls. A sequence with a larger cache does not, so do not create the sequence with a larger cache. A sequence never gives a number again, and `pg_dump` keeps its last number. The tokens thus increase across all machines and across a restore of a dump. Gaps between tokens are normal.

### Sessions and the pool

The store keeps a session for each key that this process holds or waits for. A holder check gets one more session for one query. A cancel needs no session. If the pool has no free session, `connect` waits.

A session that holds nothing goes back to the pool with `release()`. A session whose lock state is not known is destroyed with `release(true)`, because a plain `release()` keeps the lock on the session. The next caller that borrows that session would then get the key at once (see [Evidence](#evidence)).

## Acquire modes

`tryAcquire` gives up at once if another caller in this process holds or waits for the key. Otherwise it gets a session and runs `SELECT pg_try_advisory_lock($1::bigint)` once. If the result is `false`, the session holds nothing, so the store gives it back with `release()`. A waiter that gives up closes its session as a cancel does, or leaves the in-process queue. See [acquire modes](../concepts/acquire-modes.md).

## Holder check

`isHeld(key)` gets a session, reads `pg_locks`, and gives the session back. It never runs an advisory lock function, so it never makes a key busy ([ADR 0015](../adr/0015-a-holder-check-never-acquires-the-key.md)). `pg_locks` shows a 64-bit number in two columns: the high half in `classid` and the low half in `objid`, with `objsubid` equal to 1. Advisory locks belong to one database, so the query reads only the rows of the current database:

```sql
SELECT EXISTS (
  SELECT 1 FROM pg_catalog.pg_locks
  WHERE locktype = 'advisory'
    AND database = (SELECT oid FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database())
    AND objsubid = 1
    AND ((classid::bigint << 32) | objid::bigint) = $1::bigint
    AND granted
) AS held
```

A waiter has a row with `granted` equal to `false`, so it does not count as a holder. The Postgres documentation says that `pg_locks` is not always fully consistent. The holder can also change before the answer arrives. Show the answer, but do not acquire a key because of it.

## Failure modes

- **A holder process stops:** its kernel closes the connection. The server ends the session and releases the key. The next waiter gets the key.
- **A session ends while the holder runs:** the server releases the key at once, and another holder can get it. Causes: the network drops the connection, `pg_terminate_backend`, `idle_session_timeout`, and a restart of the server. The session emits `error` or `end`. The store then aborts the signal of the lease with `LeaseLostError` ([ADR 0013](../adr/0013-a-lost-lease-aborts-the-signal-of-the-lease.md)). node-postgres can emit `error` two times for one end, and the lease is lost only one time.
- **The server restarts, or a standby is promoted:** each session ends, so each key is released and each holder gets a lost lease. Postgres does not write advisory locks to the WAL, so a promoted standby holds none of the locks of the old primary.
- **A silent partition:** the network stops and sends no reset. The server can release the key, and the holder does not see the end of its session. The [heartbeat](#the-heartbeat) finds it within `heartbeatInterval`, and the signal of the lease aborts. Until then, only the [fencing token](../concepts/fencing-tokens.md) protects the resource. A waiting session has no heartbeat: set `keepAlive: true` and `keepAliveInitialDelayMillis` on the pool (the example uses `10_000`), so that TCP keep-alive finds a dead connection of a waiter within seconds. With `keepAliveInitialDelayMillis` equal to `0`, Node.js keeps the idle time of the operating system, approximately 2 hours on Linux.
- **A holder machine stops with no reset:** the server sees the end of the session only through its own TCP keep-alive (`tcp_keepalives_idle`, `tcp_keepalives_interval`, `tcp_keepalives_count`). Until then, the key stays held, and waiters wait.
- **A cancelled waiter stays on the server:** its process waits in the lock queue as a phantom waiter until the key is free, and uses one connection slot of the server. Set `client_connection_check_interval` to end it sooner. See [A cancel](#how-it-works).
- **A holder freezes:** waiters wait. If the server ends the session meanwhile, another holder can get the key. The frozen holder sees the lost lease only when it runs again. A [fenced resource](../concepts/fencing-tokens.md) refuses its late writes.
- **PgBouncer in transaction pooling or statement pooling:** not supported. PgBouncer gives the server connection to another client after each transaction or statement. That client then holds the lock of the holder, and Postgres grants the key to it at once. The unlock of the holder can run on another server connection. Use PgBouncer in session pooling, or connect to Postgres directly.
- **A reset of a session:** `DISCARD ALL` releases each advisory lock of the session. `RESET ALL` does not. Do not run `DISCARD ALL` on a session that the store holds.
- **Timeouts on the session:** do not set `query_timeout` on the pool that `connect` uses. It is a setting of node-postgres on the client, so the store cannot change it. When it fires, node-postgres rejects the query, but the server continues to wait and later grants the lock to a session that nobody uses (see [Evidence](#evidence)). The store sets `statement_timeout` and `lock_timeout` to `0` before it waits, and resets them before it gives the session back.
- **The sequence does not exist:** the first grant fails with the error of Postgres (`relation "<sequence>" does not exist`), and the call rejects. The store releases the key when it cannot make the token. Create the sequence (see [The token](#how-it-works)).
- **The tokens after a promotion:** a sequence writes its numbers to the WAL in blocks ahead of use. A standby that was promoted with asynchronous replication could perhaps give a token again that the old primary gave. We did not test this. Use synchronous replication if your fenced resource must never see a token two times.

See [failure modes](../concepts/failure-modes.md).

## Options

| Option              | Default | Description                                                                                                                                                                                                  |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `connect`           | —       | A function that gives a new session. `pool.connect` of `pg.Pool` fits. A session has `query(text, values)`, `on('error' \| 'end')`, `off`, and `release(destroy)`. The store owns each session that it gets. |
| `sequence`          | —       | The name of an existing sequence for the fencing tokens. Create it before the app starts; the store runs no DDL.                                                                                             |
| `heartbeatInterval` | —       | Milliseconds between two heartbeats of a holder, and the time limit of each heartbeat. It is the longest time that a holder can work after its session ended, before its signal aborts.                      |

All three options are required. No option has a default.

## Evidence

No test exists yet. These facts come from probes before the design. Each probe used `pg` (node-postgres) 8.23.1. The server was PostgreSQL 18.3, except where the item says `postgres:18-alpine`:

- **Locks stack in one session.** One session ran `pg_advisory_lock(-2)` two times. Then `pg_advisory_unlock(-2)` three times returned `true`, `true`, `false`, with the warning `you don't own a lock of type ExclusiveLock`. `pg_locks` showed one row for the number. Thus one session never excludes itself.
- **A plain pool release gives the lock to the next borrower.** In a `pg.Pool` with `max: 1`, client A locked 11 and called `release()`. Client B got the same server process, `pg_locks` still showed 11 as held, and B's `pg_try_advisory_lock(11)` returned `true`. After `release(true)`, `pg_locks` showed no holder.
- **`query_timeout` leaves the lock on the server.** A waiter with `query_timeout: 300` ran `pg_advisory_lock(9)` while another session held 9. The query rejected with `Query read timeout`. When the holder disconnected, `pg_locks` showed the waiter's process holding 9 with `granted` equal to `true`. The client still answered later queries, so nothing told it that it held the lock.
- **The holder check gives back each number.** For the numbers −2, −2⁶³, 2⁶³−1 and 1, the `pg_locks` query found the number that was locked. It answered `false` for 2 and −1. A number sent as the text `'-2'` with `$1::bigint` also matched.
- **`RESET ALL` keeps the locks, and `DISCARD ALL` releases them.** After `RESET ALL`, a session still held its 3 advisory locks. After `DISCARD ALL`, it held 0.
- **`nextval` follows the order of the calls.** With `CACHE 1`, two sessions called `nextval` in turn and got 1, 2, 3, 4, 5, 6. node-postgres returned each number as a string.
- **A closed waiter becomes a phantom waiter, and the key still goes to the next waiter** (`postgres:18-alpine` in Docker). A waiter in `pg_advisory_lock(33)` was destroyed with `release(true)`. Its query rejected at once with `Connection terminated`. While the holder held the key, `pg_stat_activity` still showed the waiter's process as `active`, with `wait_event_type` equal to `Lock`. When the holder released the key, the next waiter got it 2 ms later, and the phantom process was gone.
- **An ended session releases its locks and emits its events.** After `pg_terminate_backend`, the client emitted `error` two times and then `end`. Its lock was gone at once.
- **A role without `CREATE` fails `CREATE SEQUENCE IF NOT EXISTS`, also when the sequence exists** (`postgres:18-alpine` in Docker). The owner created `app_lock_tokens` and gave a new login role `USAGE` on it. That role ran `CREATE SEQUENCE IF NOT EXISTS app_lock_tokens` and got `42501 permission denied for schema public`. Its `nextval('app_lock_tokens')` returned 1. Thus the store runs no DDL.
