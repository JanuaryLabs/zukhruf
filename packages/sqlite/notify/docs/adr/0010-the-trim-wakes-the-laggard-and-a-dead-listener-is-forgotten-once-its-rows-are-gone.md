# The trim wakes the laggard, and a dead listener is forgotten once its rows are gone

One file holds every channel. The trim and the full check read the lowest position over all listeners, whatever their channels ([ADR 0005](./0005-a-row-stays-until-each-listener-read-it.md)). Before this decision, a sender found a dead listener only when a wake to that listener's own channel failed ([ADR 0003](./0003-no-hub-each-listener-serves-its-own-socket.md)). Thus a listener that was killed on a channel that nobody sends on again kept its row. Its position held the trim of every channel, and each sender on every channel got `QueueFullError` when the queue was full (backlog #4396). The pool for the computer (#3527) puts every pool of the computer in one file, so a killed host of a quiet pool fills the queue for all.

A second defect has the same result. When `notify` runs in a caller's transaction, it runs in a savepoint. The sender forgot the dead listeners and removed their socket files when the savepoint was released. When the caller's transaction then rolled back, the removal of the rows rolled back too, and the sender did not know the rows any more.

The probes (research 20j, 2026-11-15) ran 7 arms against 7 scenarios: 5 runs of each on macOS, and S1, S2 and S4 also on Linux. Each arm was the code of that day plus one option. With today's code (S1: a listener killed on `'quiet'`, senders on `'busy'`, `maxQueuedNotifications` 50), the first `QueueFullError` came 4.6 to 5.0 s after the kill in every run, and the row was never removed.

Postgres has the same rule for its tail: the tail is the lowest position over the registered listeners (`async.c` at `REL_18_1`, `:2136-2142`). Its `SignalBackends` also signals a listener in another database that is far behind, "so that they'll advance their queue position pointers, allowing the global tail to advance" (`:1569-1573`, `:1616-1624`; research 20k §2). Postgres never keeps a dead listener: an exit unregisters it (`:1063`, `:823-827`, `:1231-1265`), and a crash of a backend restarts the shared memory (`postmaster.c:3202-3220`). Both need a server. This package has no server ([ADR 0003](./0003-no-hub-each-listener-serves-its-own-socket.md)).

## Decision

**Wake the laggard.** A laggard is a listener at the lowest position, when that position is below the highest id: the trim waits for it.

- At its trim, at most once a second, a sender also reads the laggards and wakes each one, whatever its channels. The read is one more statement in the sender's transaction.
- A live laggard reads, as its backstop does. It writes its position at the next backstop.
- A dead laggard refuses the connect (`ECONNREFUSED` or `ENOENT`). The sender then marks it dead, as for a wake to its channel. The next transaction of the sender removes its rows.
- A hung laggard (`SIGSTOP`) accepts the connect: the system queues the connection for the stopped program. It keeps its row and holds the trim, as Postgres keeps a stuck listener (C10).

**Forget a dead listener only after its rows are known to be gone.**

- The sender removes the rows of each dead listener in each `notify`, in a transaction of its own or in the caller's transaction.
- After a `notify` that ran in a `BEGIN IMMEDIATE` transaction of its own, the sender forgets the dead listener and removes its socket file at once. That transaction returned, so it committed the removal.
- After a `notify` in the caller's transaction, the sender reads on the next microtask whether the rows of those dead listeners are still there. It forgets each listener whose row is gone, and removes its socket file. It keeps each listener whose row is still there, because the caller rolled back. Its next `notify` removes the rows again. A delete of a row that is not there changes nothing, so a second removal is safe.
- If a transaction is still open on the connection at that microtask, the sender does nothing. Such a caller keeps a transaction across an await, which the family's rule forbids. Its next `notify` removes the rows again and reads again.

`node:sqlite` has no commit hook, so `notify` cannot learn when the caller's transaction commits. The next microtask is the moment of [ADR 0004](./0004-the-wake-goes-out-after-the-synchronous-transaction.md): the caller's synchronous transaction has ended by then, committed or rolled back. The check is one read by key for each dead listener. It writes nothing, and a read of a WAL file does not wait for a writer. A row that is gone was removed by a commit, this sender's or another's, so forgetting it is right either way.

## Considered Options

The numbers are from research 20j. "Removed" and "caught up" count from the kill. "Caught up" is the first sample with no queued row at or below the highest id at the kill.

- **A, wake the laggard (about 15 lines).** S1: 0 `QueueFullError` in 25 runs on macOS and 5 on Linux. The row was removed in 200 to 211 ms on macOS, and the trim caught up in 1.2 to 1.4 s on macOS. S2 (a listener stopped 15 s): kept, and it got its 36 rows once, in order. S3 (a dead row whose `process_id` is a live, other process): removed in 1.2 to 1.6 s. S4 (the only listener killed, only senders left): removed in 0.2 s. No schema change, no idle connection, no idle write.
- **B, `process.kill(process_id, 0)` at the trim (39 lines).** S3 failed in 5 of 5 runs: a reused process id keeps the dead row. It is the check before the operation that EAFP replaces, and no system of research 20k uses it.
- **C, a heartbeat with a deadline of 30 s (47 lines, a new column).** S1, S3, S4, S5 and S5b failed: the queue was full at 4.6 s, and the row went at about 30 s. A deadline that keeps every hang is longer than the time to fill the queue. It is also the only arm with writes while idle (10 a second for 10 listeners).
- **D1, a mesh of listeners (90 lines).** S3, S4 and S5b failed. Nobody sees the only listener die, or a listener killed before its peers connected. It holds 45 idle connections for 10 listeners.
- **D2, every instance connects to every listener (144 lines).** It passed every scenario, but S3 and S5b only through its pull: each send dials every row that it has no connection to. That is A for every row on every send. It holds 75 connections under load.
- **D1A, D1 with A behind it (105 lines).** It passed every scenario. The mesh removed a row in about 15 ms, but the trim caught up in 1.0 to 1.4 s, as with A, because the trim runs at most once a second. It costs D1's mesh, and one empty write for each peer that ends.
- **No arm fixed the forgotten dead listener of S5.** A, B, D2 and D1A only found the row again at their next look at the table.
- **Forget only after a transaction of the sender's own.** It fixes S5, but a sender that always sends in the caller's transaction never has one. That is the main consumer: sqlite-queue notifies inside its insert transaction (#4334), as pg-boss sends `pg_notify` inside its insert. Its dead listeners stayed in the sender's memory, each `notify` deleted their rows again, and their socket files were never removed.

A was selected. It is the smallest arm that passed every scenario on both systems, its connect is the real operation (EAFP), and it has Postgres's precedent. Ezz prefers push. Push alone (D1) cannot see every death, and the push arms that passed did so through a pull.

## Consequences

- A dead listener's row holds back the trim until the next trim of a sender, at most about one second after the next send on any channel. Then the sender's next transaction removes it.
- When no program sends, a dead row stays. No sender then waits for the trim.
- Each sender wakes the laggards at most once a second, and keeps a connection to each one that it woke. In S6 (10 listeners, 3 senders at 100 a second each) A held 29 to 30 connections under load, against 15 before.
- A laggard that also listens on the channel of the send gets one wake from that send, not two.
- A hung laggard still holds the trim and, at the limit, fails each sender with `QueueFullError`, as in Postgres.
- In the caller's transaction, each `notify` removes the rows of the dead listeners again until a commit removes them. The read on the next microtask costs one read by key for each dead listener, and only while the sender knows one.
- A caller that keeps a transaction open across an await keeps the dead listeners and their socket files until a `notify` whose transaction has ended by its microtask.
- Not proven by research 20j:
  - On Linux, one run of each D arm caught up only after 2.4 to 2.6 s, with 36 to 46 of 50 rows queued. The cause was not found.
  - One A run in S6 had a commit time of 1.1 s at most, at a host load of 12.3. With 1 of 5 runs, it is not told apart from noise.
  - A close that is not a death (for example `EMFILE`, or a reset under load) was never forced. A sender marks a closed connection dead, so such a close removes a live listener.
  - Windows did not run, and no run had more than 10 listeners.
