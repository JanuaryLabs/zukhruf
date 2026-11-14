# The queue is the truth and the wake is a hint

Postgres is a log that each listener reads, plus a signal with no content. The sender writes its notifications into a shared queue before its commit is marked, and signals each listening session after the commit. A signalled session reads the queue from its own position (`async.c:59-104`, confirmed in research 20g). The queue gives "only at commit", the payload and the order. The signal gives only the speed.

A wake that carries the payload, with no table, is simpler. But then a sender that dies after its commit and before its wake loses the notification, and the order is the order of arrival, not of the commits (research 19 §4). Postgres has neither loss.

## Decision

The notifications are rows of `zukhruf_notify_queue`, in the same file, written in the sender's own transaction. The wake is one byte with no content.

- `id INTEGER PRIMARY KEY AUTOINCREMENT`. The ids are in commit order: 24 of 24 runs, about 246,000 rows on each of macOS and Linux, both journal modes, 0 rows missed, late or read twice (research 20b T1). `AUTOINCREMENT` is required: a plain `INTEGER PRIMARY KEY` gives trimmed ids again, and a listener's last id then skips the new rows (research 20b T2).
- A listener reads `id > last` on its own connection, outside any transaction, with one statement read to the end. A connection inside a read transaction, or with an unfinished iterator, sees no new rows (research 20b T4).
- A listener registers in one `BEGIN IMMEDIATE` transaction that inserts its address and reads the highest id. This is Postgres's rule for the start (C13): commit the `LISTEN`, then rely on notifications.
- A wake that finds no row is a normal case. A rollback, a checkpoint and a `VACUUM` give one (research 20b T3).
- The backstop: every second, each listener reads `PRAGMA data_version` on its own connection, and reads the queue when it changed. It changes for each commit of another connection and never for a rollback (research 20b T3). On its own connection, the listener's own position writes do not change it. It finds a row whose wake was lost: a sender that died between its commit and its wake (research 20c M6). Its cost with a 1 s interval is 0.01 to 0.05 % of a core for each idle listener (research 20c M3). pg-boss keeps a poll beside its own `NOTIFY` for the same reason (`sqlite/queue/src/attorney.ts:166`).
- The backstop runs as a `ChangeWatcher` of `@zukhruf/async` on the given clock, over a gauge of that pragma.
- The tables are a `Declaration` of `@zukhruf/sqlite-drift` with `rows: 'keep'`, as in `@zukhruf/sqlite-queue` ADR 0004.

## Considered Options

- **The payload in the wake, no table.** A sender that dies after its commit loses the notification, and the order is not the commit order.
- **The poll of `data_version` as the only wake** (honker's default). Every 1 ms it costs 2.0 to 4.6 % of a core for each idle listener; every 20 ms it notices in 11 to 12 ms (research 20b T3).
- **A bell file with `fs.watch`.** On macOS it missed the last write of a burst in 3 of 30 bursts, and lost a write before the first turn of the event loop (research 20a P2).
- **A table of rows and a wake with no content.** This option was selected.

## Consequences

- Each line of the contract that is about content (C2, C5, C6, C8, C12) rests on the table, not on the carrier.
- A sender that dies after its commit loses nothing: the backstop finds the row within one second.
- A lost wake costs at most one second, never a notification.
- The table grows, so it needs a trim ([ADR 0005](./0005-a-row-stays-until-each-listener-read-it.md)).
- The wake has no content, so it needs no protocol, no version and no handshake. A listener reads the queue on any byte that comes.
