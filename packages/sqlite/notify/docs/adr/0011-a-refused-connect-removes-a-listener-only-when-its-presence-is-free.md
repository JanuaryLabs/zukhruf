# A refused connect removes a listener only when its presence is free

Status: Accepted 2026-11-24 by Ezz (backlog #5424). For the question of the fact that tells a dead listener from a live one whose connect is refused, Ezz chose "A FileLock presence (Recommended)". For the extraction of the presence into `@zukhruf/fs`, Ezz said: "I would avoid any kind of extraction right now, okay? Keep the copy and file it for later." The extraction is #5463.

A sender marked a listener dead when its connect rejected with `NoServerError` of `@zukhruf/pipes` ([ADR 0010](./0010-the-trim-wakes-the-laggard-and-a-dead-listener-is-forgotten-once-its-rows-are-gone.md)). Then its next transaction removed the listener's rows, and it removed the socket file. On macOS a live server whose listen queue is full refuses a connect with `ECONNREFUSED`, the code of a killed listener's socket file, after 128 connections (`kern.ipc.somaxconn`; XNU `unp_connect` refuses when `sonewconn` finds the queue full). Linux gives `EAGAIN` after 512 connections (probe 2026-11-23, backlog #5424). So on macOS a sender removed the rows and the socket file of a live listener that was stopped (`SIGSTOP`) or flooded with connects. That listener then got no more wakes, and its rows no longer held the trim, so it lost notifications. The test "a stopped listener program whose listen queue is full refuses the wake" (`src/queue.test.ts`, 35136e9a) showed it.

## Decision

**Each listener holds a presence: a kernel lock on a file of its own beside the database.**

- The file is `<database>.listeners/<listener id>.presence`. `<database>` is the path that `DatabaseSync.location()` gives. The lock is a `FileLock` of `@zukhruf/fs`, which the kernel frees when the process stops, however it stops.
- The file is beside the database, not beside the socket: on Windows a pipe is no file, and every program that uses the database can write in its folder, as SQLite's `-wal` and `-shm` files need. One folder holds the files of all listeners, as mutex's `SqliteStore` keeps its holder files in `<lock>.holder/`. The listener id is the key of the row and the name of the socket, so a sender that read the row knows the file. The suffix `.presence` is mutex's.
- The first `listen` takes the presence after it opens its connection and before the transaction that inserts its row. So a sender never reads the row of a live listener whose presence is not taken. The id is new, so no other program knows the file before the row.
- The listener ends its presence after it removed its rows and closed its socket and its connection. So the presence outlasts the row.

**A sender asks the presence only for a refused connect, and not on Linux.**

- When the cause of `NoServerError` is `ECONNREFUSED` and the system is not Linux, the sender reads `FileLock.check` of the listener's presence. `'locked'`: the listener lives. The wake is lost, the error goes to `error`, and the next send connects again, as for `EAGAIN` on Linux. `'unlocked'` or `'missing'`: the listener is dead, as before.
- The other causes keep their meaning: `ENOENT` (no file), `ENOTSOCK` (macOS, a file that is not a socket) and `ECONNRESET` (Linux, a listener that closed during the connect) find no server at the address. On Linux, `ECONNREFUSED` proves that no server listens.
- A check from the listener's own process is safe. `FileLock.check` answers `'locked'` there and keeps the lock: SQLite keeps the descriptor open while a connection of the process holds a lock (`setPendingFd` in `os_unix.c`; `packages/fs/src/file-lock.test.ts`, the tests "in the process that holds the lock").
- A listener of a release before this one has no presence file, and maybe no folder. It reads `'missing'` and counts as dead on a refused connect, as before.

**A file is deleted only by a program that holds its lock.**

- A sender that removed a dead listener's rows also deletes its presence file, under the lock of the file, after the removal has committed. A presence that it cannot lock belongs to a live listener, and stays.
- The listener deletes its own file while it holds the lock, then frees it. Thus a program that opened the file and is about to lock it never keeps a lock on a file that is gone. Windows does not delete a file that a handle keeps open: there the lock is freed first, and a refusal of the delete then means that another program opened the file. This is the order of `#deleteIfFree` of mutex's `SessionDirectory` ([mutex ADR 0033](../../../../mutex/docs/adr/0033-a-new-leader-grants-nothing-until-each-recorded-session-reasserted-its-keys-stopped-or-missed-its-lease.md)).

The presence is a copy of the knowledge of mutex's `Presence` and `SessionDirectory` (`docs/copied-code.md`). It uses `FileLock` directly and adds no API to `@zukhruf/fs`.

## Considered Options

- **`process.kill(process_id, 0)` before the removal.** The row names the listener's process id. Research 20j S3 rejected it ([ADR 0010](./0010-the-trim-wakes-the-laggard-and-a-dead-listener-is-forgotten-once-its-rows-are-gone.md), option B): a reused process id keeps a dead row. A kernel lock cannot be fooled by a reused id.
- **A lock file beside the socket (`<address>.lock`).** On Windows a pipe is no file, so the address has no folder to write in.
- **Extract the presence into `@zukhruf/fs` now.** This is the fourth place of the same knowledge (#5463: mutex `Presence`, mutex `SessionDirectory`, the install lease of `@zukhruf/git-hooks`, and this one). Ezz deferred it.

## Consequences

- The database's folder gets the folder `<database>.listeners`. It stays when it is empty.
- Each first `listen` creates one file, and each end of a listener deletes it. A killed listener's file stays until a sender removes its rows.
- On macOS a stopped or flooded listener keeps its rows and its socket file, and gets every notification after it runs again (`src/queue.test.ts`, "a full listen queue"). Its refused wake goes to `error` of the sender.
- A sender that finds a listener's connect refused opens and reads its presence file once: one more SQLite open, read-only.
- Not proven by a test:
  - The end of the presence after the removal of the row, and the order of the delete, depend only on timing. The presence before the row has a test: "a listener program takes its presence before its row" (`src/queue.test.ts`).
  - A sender on Linux does not ask the presence. A Linux sender would get the same answer for a killed listener.
  - Windows did not run. On Windows a listener's file that a sender's check keeps open at the end of the listener stays, and nobody deletes it.
