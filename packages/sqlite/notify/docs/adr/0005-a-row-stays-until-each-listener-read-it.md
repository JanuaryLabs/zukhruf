# A row stays until each listener read it

Changed in part on 2026-11-15 (#4396) by [ADR 0010](./0010-the-trim-wakes-the-laggard-and-a-dead-listener-is-forgotten-once-its-rows-are-gone.md): at its trim, a sender also wakes the laggards, the listeners at the lowest position, whatever their channels. A dead laggard refuses the connect, and the sender removes its rows. The rest of the decision below stays true.

The notification queue grows with each `notify`. Something must delete the rows. The prior art differs (research 19 §2): Solid Cable trims rows older than one day, so a listener that is slower loses rows; honker leaves the trim to the caller. Postgres keeps each entry until every listener has read it, and fails the sender when the queue is full: "transactions calling NOTIFY will fail at commit" (C10).

In Postgres, each listener has a queue position, and the tail is the lowest one. A sender advances the tail after it commits, but only once every `QUEUE_CLEANUP_DELAY` (4) pages, because the work is "relatively expensive" (`async.c:106-110, 225-238, 1015-1027, 2110-2135`). The queue holds `max_notify_queue_pages` pages, 1048576 by default (`async.c:428`). When it is full, the sender fails with `too many notifications in the NOTIFY queue`, `ERRCODE_PROGRAM_LIMIT_EXCEEDED` (54000), before its commit is marked (`async.c:930-950`).

## Decision

Postgres's rule, on the table:

- A row stays until each registered listener has read it.
- Each listener writes its position to its row at most once a backstop interval (1 s), and only when it moved.
- A sender deletes the rows below the lowest position, in its own transaction, at most once a second, and at most 10,000 rows in one trim. With no listener, the lowest position is the highest id, so the trim deletes every row, 10,000 at a time.
- A position write that fails because the file is busy is not an error. The listener tries again at the next backstop. Until then the trim keeps those rows.
- `notify` counts the rows above the lowest position: the highest id minus the lowest position, read from `sqlite_sequence` and the index on `position`. When the count is `maxQueuedNotifications` or more, `notify` throws `QueueFullError`, with Postgres's message and `code` `54000`. The transaction of the call does not commit, which is Postgres's "fail at commit".
- The default of `maxQueuedNotifications` is 1048576. A Postgres queue at its default holds at least that many notifications of the largest payload, one for each page.

Measured on macOS and Linux (research 20i, 2026-11-14, host load 29 or below):

- **The position writes cost the senders nothing.** With 12 listeners that write their position once a second (or every 100 ms), the senders' throughput and their commit times p50, p95 and p99 stayed inside the spread of a run with no position writes, at 100 and at 1,000 notifications a second for each sender.
- **But they can fail.** When the senders never pause, 10 to 13 % of the once-a-second position writes failed with `database is locked` after the busy timeout. So a failed position write is skipped, not reported (the decision above).
- **The delete costs about 0.2 µs a row**: 0.1 to 0.15 ms for 1,000 rows, 19 ms for 100,000, 200 to 260 ms for 1,000,000. At 1,000,000 rows the transaction held the write lock 0.3 to 0.86 s. A trim that waited behind a stalled position comes as one large delete, so a trim deletes at most 10,000 rows (about 2 ms). At most once a second, that drains 10,000 rows a second, more than the senders' measured rate.
- **A listener that never moves** holds the trim. The table grew by 6,000 rows (0.35 MB) a minute at 100 notifications a second, and 60,000 rows (3.5 MB) at 1,000, about 59 bytes a row. At the default limit that is about 62 MB with short payloads, and 8 GB with payloads of 8,000 bytes, Postgres's own default.
- **The check for a full queue is cheap and exact**: the highest id and the lowest id read as two subqueries took 0.01 to 0.02 ms at 1,000,000 rows, with 0 mismatches in 20 checks on each system. A `count(*)` took 8 ms, and one query for both ends scanned the table (27 ms).
- **No row was lost**: 955,952 committed rows over 387 trims, every listener read each one once and in order, and `AUTOINCREMENT` kept the ids rising.

## Considered Options

- **Delete rows after a time, as Solid Cable.** A listener that is slower than the time loses rows, with no error.
- **Leave the trim to the caller, as honker.** Each host writes the same trim.
- **Postgres's rule: the lowest position, and a full queue fails the sender.** This option was selected.

## Consequences

- No listener loses a row. A listener that stops reading, for example one that hangs, holds back the trim, as in Postgres ("A listener that stays in a transaction blocks the cleanup", C10).
- A dead listener's row holds back the trim until the next trim of a sender, on any channel, wakes it as a laggard. The connect is refused, and the sender's next transaction removes the row ([ADR 0010](./0010-the-trim-wakes-the-laggard-and-a-dead-listener-is-forgotten-once-its-rows-are-gone.md)).
- A sender's transaction does one more delete of at most 10,000 rows (about 2 ms) at most once a second.
- A listener writes its row at most once a second, so its position is up to one second behind what it read. The trim keeps those rows one second longer.
- A full queue fails each sender until the slow listener reads or is removed. The error names the cause in Postgres's words.
