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
});

const mutex = new Mutex(
  new PostgresStore({
    connect: () => pool.connect(),
    sequence: 'app_lock_tokens',
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
- You cannot let the store hold one session for each held key. See [Sessions and the pool](#sessions-and-the-pool).

## How it works

**The number of a key.** An advisory lock takes a 64-bit integer, not a text. The store calculates the SHA-256 digest of the key. It reads the first 8 bytes of the digest as a signed 64-bit integer. It sends that integer as text and casts it in SQL (`$1::bigint`), because a JavaScript `number` cannot hold 64 bits. The store does not use `hashtextextended`: it is an internal Postgres function, and its result can change between major versions. DistributedLock also hashes on the client: its `allowHashing` option cuts a SHA-1 digest to 8 bytes.

Two keys can get the same number. Then they are one lock: one key waits for the other. This is false contention, not two holders, because two keys never share a session. Other software that uses advisory locks in the same database uses the same numbers.

**One session for each held key.** Postgres grants a lock again to a session that already holds it. The locks stack, and each lock needs its own unlock. Thus a session that holds a key never asks for a second key, and a second caller of a key never uses the session of the holder.

1. Callers in one process first line up in a queue in memory, in the order of their calls. Only the first caller in that queue continues to the next step. Thus one process uses at most one session for each key, however many callers wait.
2. That caller gets a session from `connect`. The store attaches its own `error` and `end` listeners at once.
3. The session reads its server process ID with `SELECT pg_backend_pid()`.
4. The session runs `SELECT pg_advisory_lock($1::bigint)`. The query waits in Postgres' lock queue until the server grants the lock. The store does not poll.
5. After the grant, the session runs `SELECT nextval(<sequence>)`. The store reads the result with `BigInt` and makes the fencing token from it. A later grant always runs `nextval` later, so it gets a larger number.
6. To release the key, the session runs `SELECT pg_advisory_unlock($1::bigint)`. If the result is `true`, the store gives the session back with `release()`. Then the next caller in the in-process queue continues.

**A cancel.** A caller cancels its wait with a signal. The waiting session cannot send a second query while its first query waits. Thus the store gets a second session from `connect` and runs `SELECT pg_cancel_backend(<process ID of the waiter>)` on it. The wait of the waiter then fails with SQLSTATE `57014`. The server can grant the lock just before the cancel arrives, so the store then reads `pg_locks` for the process ID of the waiter. If that process holds the number, the store unlocks it. Then the store destroys the waiting session with `release(true)`, and the call rejects with `signal.reason`. See [ADR 0023](../adr/0023-a-postgres-waiter-is-cancelled-from-a-second-session.md).

**The token.** The tokens come from one Postgres sequence that you name with `sequence`. Before the store makes its first token, it runs `CREATE SEQUENCE IF NOT EXISTS <sequence> AS bigint CACHE 1`. `nextval` gives each session a different number, also when many sessions call it at the same time. A sequence with `CACHE 1` gives the numbers in the order of the calls. A sequence with a larger cache does not, so do not create the sequence with a larger cache. A sequence never gives a number again, and `pg_dump` keeps its last number. The tokens thus increase across all machines and across a restore of a dump. Gaps between tokens are normal.

### Sessions and the pool

The store keeps a session for each key that this process holds or waits for. A cancel and a holder check each get one more session for one query. If the pool has no free session, `connect` waits, and a cancel waits with it. Thus give the pool more sessions than the number of keys that this process holds or waits for at one time.

A session that holds nothing goes back to the pool with `release()`. A session whose lock state is not known is destroyed with `release(true)`, because a plain `release()` keeps the lock on the session. The next caller that borrows that session would then get the key at once (see [Evidence](#evidence)).

## Acquire modes

`tryAcquire` gives up at once if another caller in this process holds or waits for the key. Otherwise it gets a session and runs `SELECT pg_try_advisory_lock($1::bigint)` once. If the result is `false`, the session holds nothing, so the store gives it back with `release()`. A waiter that gives up cancels its wait as a cancel does, or leaves the in-process queue. See [acquire modes](../concepts/acquire-modes.md).

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
- **A silent partition:** the network stops and sends no reset. The holder does not see that its session ended, and the server can release the key. Set `keepAlive: true` on the pool, so that TCP keep-alive finds the dead connection and the session emits `error`. Until then, only the [fencing token](../concepts/fencing-tokens.md) protects the resource. The store sends no heartbeat query.
- **A holder machine stops with no reset:** the server sees the end of the session only through its own TCP keep-alive (`tcp_keepalives_idle`, `tcp_keepalives_interval`, `tcp_keepalives_count`). Until then, the key stays held, and waiters wait.
- **A holder freezes:** waiters wait. If the server ends the session meanwhile, another holder can get the key. The frozen holder sees the lost lease only when it runs again. A [fenced resource](../concepts/fencing-tokens.md) refuses its late writes.
- **PgBouncer in transaction pooling or statement pooling:** not supported. PgBouncer gives the server connection to another client after each transaction or statement. That client then holds the lock of the holder, and Postgres grants the key to it at once. The unlock of the holder can run on another server connection. Use PgBouncer in session pooling, or connect to Postgres directly.
- **A reset of a session:** `DISCARD ALL` releases each advisory lock of the session. `RESET ALL` does not. Do not run `DISCARD ALL` on a session that the store holds.
- **Timeouts on the session:** do not set `query_timeout` on the pool. When it fires, node-postgres rejects the query, but the server continues to wait and later grants the lock to a session that nobody uses (see [Evidence](#evidence)). `statement_timeout` and `lock_timeout` also stop a wait. Set them to `0` for the sessions of the store.
- **A role with no `CREATE` permission:** `CREATE SEQUENCE` fails with `permission denied for schema public`. Create the sequence before you start the app, with `CACHE 1`, and give the role `USAGE` on it.
- **A cancel with no permission:** `pg_cancel_backend` needs the same role as the waiter, or the role `pg_signal_backend`. The sessions of one `connect` function use one role.
- **The tokens after a promotion:** a sequence writes its numbers to the WAL in blocks ahead of use. A standby that was promoted with asynchronous replication could perhaps give a token again that the old primary gave. We did not test this. Use synchronous replication if your fenced resource must never see a token two times.

See [failure modes](../concepts/failure-modes.md).

## Options

| Option     | Default | Description                                                                                                                                                                                                  |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `connect`  | —       | A function that gives a new session. `pool.connect` of `pg.Pool` fits. A session has `query(text, values)`, `on('error' \| 'end')`, `off`, and `release(destroy)`. The store owns each session that it gets. |
| `sequence` | —       | The name of the sequence of the fencing tokens. The store creates it if it does not exist.                                                                                                                   |

Both options are required. Neither option has a default.

## Evidence

No test exists yet. These facts come from probes on PostgreSQL 18.3 with `pg` (node-postgres) 8.23.1, before the design:

- **Locks stack in one session.** One session ran `pg_advisory_lock(-2)` two times. Then `pg_advisory_unlock(-2)` three times returned `true`, `true`, `false`, with the warning `you don't own a lock of type ExclusiveLock`. `pg_locks` showed one row for the number. Thus one session never excludes itself.
- **A plain pool release gives the lock to the next borrower.** In a `pg.Pool` with `max: 1`, client A locked 11 and called `release()`. Client B got the same server process, `pg_locks` still showed 11 as held, and B's `pg_try_advisory_lock(11)` returned `true`. After `release(true)`, `pg_locks` showed no holder.
- **`query_timeout` leaves the lock on the server.** A waiter with `query_timeout: 300` ran `pg_advisory_lock(9)` while another session held 9. The query rejected with `Query read timeout`. When the holder disconnected, `pg_locks` showed the waiter's process holding 9 with `granted` equal to `true`. The client still answered later queries, so nothing told it that it held the lock.
- **The holder check gives back each number.** For the numbers −2, −2⁶³, 2⁶³−1 and 1, the `pg_locks` query found the number that was locked. It answered `false` for 2 and −1. A number sent as the text `'-2'` with `$1::bigint` also matched.
- **`RESET ALL` keeps the locks, and `DISCARD ALL` releases them.** After `RESET ALL`, a session still held its 3 advisory locks. After `DISCARD ALL`, it held 0.
- **`nextval` follows the order of the calls.** With `CACHE 1`, two sessions called `nextval` in turn and got 1, 2, 3, 4, 5, 6. node-postgres returned each number as a string.
- **A cancel from another session stops a wait.** `pg_cancel_backend` of the waiter's process returned `true`, and the waiter's `pg_advisory_lock(7)` failed with SQLSTATE `57014`.
- **An ended session releases its locks and emits its events.** After `pg_terminate_backend`, the client emitted `error` two times and then `end`. Its lock was gone at once.
- **A new role cannot create the sequence.** A new login role ran `CREATE SEQUENCE IF NOT EXISTS` and got `permission denied for schema public`.
