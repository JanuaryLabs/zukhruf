# A Postgres waiter is cancelled by closing its session

A caller of `PostgresStore` can cancel its wait with a signal ([ADR 0008](./0008-a-caller-cancels-an-acquire-mode-gives-up.md)). The waiting session runs one blocking `pg_advisory_lock`, and a session can run only one query at a time. node-postgres has no documented cancel. Its `Client#cancel` is not documented, needs the `Query` object, and cannot go through the structural session of [ADR 0022](./0022-a-database-lock-store-takes-its-session-from-the-caller.md). Thus the store cancels a wait by closing the waiting session:

1. When the signal aborts, the store destroys the waiting session with `release(true)`.
2. The query of the wait rejects at once, and the call rejects with `signal.reason`.
3. If the server granted the lock just before the close, the end of the session releases the lock. The store needs no check of `pg_locks`, because the session never goes back to the pool.

The server does not see the close at once. Its process for that session stays in the lock queue until the key is free: a **phantom waiter**. When the holder releases the key, the server finds the closed connection and ends the phantom waiter. A probe on `postgres:18-alpine` with `pg` 8.23.1 showed this. A waiter in `pg_advisory_lock(33)` was destroyed with `release(true)`, and its query rejected at once with `Connection terminated`. While the holder held the key, `pg_stat_activity` showed the waiter's process as `active`, with `wait_event_type` equal to `Lock`. When the holder released the key, the next waiter got it 2 ms later, and the phantom process was gone.

## Considered Options

- **A second session that runs `pg_cancel_backend`.** The store would read the process ID of the waiter, get a second session from `connect`, and cancel the wait from it. The server can grant the lock just before the cancel arrives, so the store would also check `pg_locks` after each cancel. Each cancel needs one more session. When all sessions of the pool hold or wait for keys, `pg.Pool#connect` puts the request in its queue of pending requests (`_pendingQueue` in `pg-pool/index.js`), so the cancel waits until a key is free. `pg_cancel_backend` also needs the same role as the waiter, or the role `pg_signal_backend`.
- **`query_timeout` of node-postgres.** It is a time limit on the client only. When it fires, node-postgres rejects the query, but the server continues to wait. In a probe on PostgreSQL 18.3 with `pg` 8.23.1, a waiter with `query_timeout: 300` rejected with `Query read timeout`. When the holder disconnected, `pg_locks` showed the waiter's process holding the lock. The client still answered later queries, so nothing told the store. The lock leaks.
- **Short `lock_timeout` slices.** The session waits for a short time, for example 500 ms, and then tries again until the signal aborts. Each new attempt goes to the end of Postgres' lock queue, so a waiter loses its place at each slice. A cancel waits up to one slice. The server can also grant the lock just after the time limit fires. Tom Lane wrote about this in BUG #17686: "I don't think there's any bulletproof way to deal with that except to check the lock status afterwards (e.g., via pg_locks)". Thus each slice needs a check of `pg_locks`.
- **A loop of `pg_try_advisory_lock`.** The store would ask again and again. The waiter would have no place in Postgres' lock queue, each attempt is a round trip, and a waiter gets the key up to one interval after the release.

## Consequences

- A cancel needs no session from the pool, and it never waits for one.
- A session after a cancel is always destroyed, never given back to the pool. Thus a lock that the server granted just before the close cannot go to the next borrower of the session.
- A phantom waiter uses one connection slot of the server until the key is free. The server setting `client_connection_check_interval` ends it sooner: the server then checks the connection of each running query at that interval. Its default `0` turns the check off.
- A phantom waiter delays the next waiter only a little. In the probe, the next waiter got the key 2 ms after the release.
