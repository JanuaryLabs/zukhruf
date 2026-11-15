# SQLite notify

A program sends a notification on a channel, in its transaction. Each program that listens on that channel, on the same SQLite file and the same computer, gets it after the commit. This package gives Postgres's `LISTEN` and `NOTIFY` for one SQLite file.

## Language

**Notification**:
One message that a sender sends on a channel: the channel, the payload and the process id. It is one row of the notification queue. Postgres's word, and the `Notification` type of `pg`.
_Avoid_: Event, message, signal (a signal is how Postgres wakes a session)

**Channel**:
The name that a sender sends on and a listener listens on. 1 to 63 bytes in UTF-8, as a Postgres identifier (`NAMEDATALEN` 64). Postgres's word.
_Avoid_: Topic, queue (the queue is the table), subject

**Payload**:
The text that a notification carries. Shorter than 8000 bytes; `''` when the sender gives none. Postgres's word.
_Avoid_: Data, body, content

**Process id**:
The `process.pid` of the program that sent a notification. Postgres gives the process id of the sender's server process; `pg` calls the field `processId`.
_Avoid_: Sender id, pid (the field is `processId`), session id

**Sender**:
A program that calls `notify`. It writes the row in its transaction, and the wakes after it.
_Avoid_: Publisher, producer, notifier

**Listener**:
One `Notifications` that listens on at least one channel. It serves one socket, has one row in the listener table, and reads the notification queue on its own connection. Postgres says "listening session"; `async.c` says listener.
_Avoid_: Subscriber, consumer, watcher

**Notification queue**:
The table `zukhruf_notify_queue`. Each row is one notification, written in the sender's transaction. Postgres's name for its own queue (`async.c`). It is the truth: a listener gives its caller only what it read here.
_Avoid_: Log, outbox, board (a word of the research), messages table

**Registration**:
The `BEGIN IMMEDIATE` transaction of the first `listen`: it inserts the listener row with its address, reads the highest id as the position, and inserts the channel row. Postgres says register (`asyncQueueRegister`).
_Avoid_: Subscribe, join, connect

**Address**:
Where a listener serves its socket: a socket path on macOS and Linux, a pipe name on Windows. The listener table keeps it.
_Avoid_: Endpoint, port, URL

**Socket folder**:
The folder of the socket files of one user: `/tmp/zukhruf-sqlite-notify-<uid>`, mode `0700`. Ours, not an industry term; tmux has the same folder for its own sockets.
_Avoid_: Runtime directory (`XDG_RUNTIME_DIR` is another folder), socket directory, temp folder

**Wake**:
One byte that a sender writes to a listener's socket after its transaction. It carries nothing: it says "read the queue". Postgres's comments say a sender wakes a listener; Postgres sends a signal for it.
_Avoid_: Notification (a notification is a row), ping, message

**Owed wake**:
A wake that a connection must write when the wake in flight is flushed. A connection has at most one wake in flight and at most one owed. Ours, not an industry term (research 20e R3).
_Avoid_: Pending wake, queued wake, retry

**Backstop**:
The read of `PRAGMA data_version` that each listener does every second, and the read of the queue when it changed. It finds a row whose wake was lost. pg-boss keeps a poll for the same purpose; the word is ours, not an industry term.
_Avoid_: Poll (the backstop is one poll; the wake is not a poll), fallback, heartbeat

**Position**:
The highest id that a listener has read, as the listener row keeps it. The listener writes it at most once a backstop interval, so it can be behind the listener's last id. Postgres's word (`QueuePosition`).
_Avoid_: Cursor, offset, checkpoint (a checkpoint moves the WAL into the database)

**Last id**:
The highest id that a listener has read, in its memory. It is never behind the position.
_Avoid_: Position (the position is the stored one), watermark

**Trim**:
The delete of the rows below the lowest position, which a sender does in its transaction, at most once a second. Postgres calls it advancing the tail (`asyncQueueAdvanceTail`); the delete of rows is ours.
_Avoid_: Prune, vacuum, cleanup, truncate

**Full queue**:
A queue with `maxQueuedNotifications` rows above the lowest position. `notify` then throws `QueueFullError`, so its transaction does not commit. Postgres's rule and message: "too many notifications in the NOTIFY queue".
_Avoid_: Overflow, backpressure, limit reached

**Dead listener**:
A listener whose address gave `ECONNREFUSED` or `ENOENT` to a connect, or closed the sender's connection. The sender removes its rows in its next transaction, and its socket file after that transaction.
_Avoid_: Stale listener, zombie, orphan

**Release**:
A published version of this package, by the `version` of its `package.json`. The file records the release that last applied the tables, in `zukhruf_notify_version`. A release leaves a file of a later release as it is (ADR 0009).
_Avoid_: Schema version (no person keeps a schema number), migration, user_version
