# A Postgres waiter is cancelled from a second session

A caller of `PostgresStore` can cancel its wait with a signal ([ADR 0008](./0008-a-caller-cancels-an-acquire-mode-gives-up.md)). The waiting session runs one blocking `pg_advisory_lock`, and a session can run only one query at a time. node-postgres has no documented cancel. Its `Client#cancel` is not documented, needs the `Query` object, and cannot go through the structural session of [ADR 0022](./0022-a-database-lock-store-takes-its-session-from-the-caller.md). Thus the cancel goes through a second session:

1. Before the wait, the waiting session reads its server process ID with `SELECT pg_backend_pid()`.
2. The waiting session runs `SELECT pg_advisory_lock($1::bigint)`. It waits in Postgres' lock queue.
3. When the signal aborts, the store gets a second session from `connect` and runs `SELECT pg_cancel_backend(<process ID>)` on it. The wait fails with SQLSTATE `57014`.
4. The server can grant the lock just before the cancel arrives. Tom Lane wrote about `lock_timeout` in BUG #17686: "the lock might get granted to us immediately after the timeout fires … I don't think there's any bulletproof way to deal with that except to check the lock status afterwards (e.g., via pg_locks)". A cancel arrives in the same way, so the store reads `pg_locks` for the process ID of the waiter. If that process holds the number, the store runs `pg_advisory_unlock`, so the key is free before the session closes.
5. The store destroys the waiting session with `release(true)`, and the call rejects with `signal.reason`.

DistributedLock does the same for Postgres: one blocking `pg_advisory_lock`, a cancel through its driver, and a check of the lock after the cancel. It never polls.

## Considered Options

- **`query_timeout` of node-postgres.** It is a time limit on the client only. When it fires, node-postgres rejects the query, but the server continues to wait. In a probe on PostgreSQL 18.3 with `pg` 8.23.1, a waiter with `query_timeout: 300` rejected with `Query read timeout`. When the holder disconnected, `pg_locks` showed the waiter's process holding the lock. The client still answered later queries, so nothing told the store. The lock leaks.
- **Short `lock_timeout` slices.** The session waits for a short time, for example 500 ms, and then tries again until the signal aborts. A cancel needs no second session. But each new attempt goes to the end of Postgres' lock queue, so a waiter loses its place. A cancel waits up to one slice. The race of BUG #17686 occurs at the end of each slice, so each slice still needs the `pg_locks` check.
- **A loop of `pg_try_advisory_lock`.** The store would ask again and again. The waiter would have no place in Postgres' lock queue, each attempt is a round trip, and a waiter gets the key up to one interval after the release.
- **A wire cancel request.** The Postgres protocol can send a cancel on a new connection with the process ID and a secret key. The structural session does not show the secret key. The protocol also says that a cancel "might or might not have any effect".

## Consequences

- A cancel needs a second session from `connect`. If the pool has no free session, the cancel waits for one.
- `pg_cancel_backend` needs the same role as the waiter, or the role `pg_signal_backend`. The sessions of one `connect` function use one role.
- Each acquire has one more round trip, for `pg_backend_pid()`.
- A session after a cancel is always destroyed, never given back to the pool. Thus a lock that the race granted cannot go to the next borrower of the session.
- The race after a cancel was not reproduced: the time between the grant and the cancel is too short for a probe. The design checks `pg_locks` each time anyway.
