# A file lock refuses a file that its process cannot write

Status: Accepted 2026-11-24 (backlog #5540).

Decision-makers: the zukhruf phase-A agent of #5540, from the probes and tests below.

A `FileLock` is an exclusive SQLite transaction on a file ([ADR 0002](./0002-a-file-lock-is-an-exclusive-sqlite-transaction.md)). When the process can read the file but not write it, for example a file with mode `0o444` or a file of another user, SQLite opens the file read-only and gives no error. SQLite then runs `BEGIN EXCLUSIVE` as a read transaction, which takes only a shared lock. Another read-only handle shares that lock. Thus before this decision:

- `tryLock()` returned `true` in two processes at the same time, on one `0o444` file (probe, Node.js 26.13.0, SQLite 3.54.0).
- `FileLock.check` from any process answered `'unlocked'` while the handle "held" the lock.
- `Presence.tryOpen` looped without an end in one synchronous call, because its check never saw its own lock.
- `Presence.removeIfEnded` tried for 1 second, and then rejected with "other processes checked it without a pause", which is not the fault.

Every user of `FileLock` had the fault: the file stores of the mutex, the key lock of `SqliteStore`, the claim of an election, the key locks of single-flight and the leases of git-hooks. A lock directory that two users share makes it happen.

## Decision

`tryLock()` tries one write in the exclusive transaction: `PRAGMA user_version = 0`. A read-only connection refuses it with `SQLITE_READONLY` (8). Then `tryLock()` rolls the transaction back and throws the `DeniedError` of `@zukhruf/sqlite-open`, with the path of the lock and the error of SQLite as its `cause`. A writable connection holds the exclusive lock already, so the write never waits. `FileLock` never commits, so the rollback of `unlock()`, of the disposal or of the end of the process undoes the write. The file does not change.

The trial is the operation itself, as "easier to ask forgiveness than permission" asks: the write fails exactly when the handle cannot hold the lock. `tryLock()` catches only `SQLITE_READONLY`, and every other error goes to the caller.

`DeniedError` is the error of `@zukhruf/sqlite-open` for a file that the system keeps from the process. The next step of a caller is the same as for a file that it cannot read: give the process access. Thus no new error class. `@zukhruf/sqlite-open` exports `SQLITE_READONLY` beside its other result codes.

`tryOpen` and `removeIfEnded` of `Presence` call `tryLock()`, so they throw the `DeniedError` at once. `removeIfEnded` opens the `file:` URI of the path with `mode=rw`, so `Presence.#lockExisting` throws a new `DeniedError` with the path of the caller, and the `DeniedError` of `tryLock()` as its `cause`. The clause `!(error instanceof DeniedError)` in `Presence.#lockExisting` is removed: the open of a `file:` URI never gives a `DeniedError`, because `UnavailableError.from` gives a plain `UnavailableError` for a `file:` name.

## Considered Options

- **Ask SQLite whether the connection is read-only (`sqlite3_db_readonly`).** `node:sqlite` of Node.js 26.13.0 does not expose it. `DatabaseSync` has no such method.
- **`PRAGMA query_only`.** It answers `0` on the read-only fallback. It tells only whether the connection refuses writes by choice.
- **Open with the URI `mode=rw`.** SQLite falls back to read-only for `mode=rw` too: the open succeeds, and `BEGIN EXCLUSIVE` succeeds.
- **`BEGIN EXCLUSIVE` or `BEGIN IMMEDIATE` alone.** Both succeed on the read-only fallback.
- **Check the write access first, with `fs.accessSync(path, W_OK)`.** It asks a different question than the lock, and the answer can change before the lock. It is a check before the act, not the act.
- **Open a second descriptor with `fs.openSync(path, 'r+')`.** On Unix, the close of any other descriptor of the file drops the POSIX record lock of the process without a word.
- **A trial write at `FileLock.open`.** The open holds no lock, so the write would wait for another holder or take a lock for a moment, and a `tryLock()` of another process at that moment would return `false`.
- **Another trial write.** `ANALYZE` fails with `SQLITE_READONLY` (8) too, but it can write statistics tables. `REINDEX` and `DROP TABLE IF EXISTS` of a missing table succeed on the read-only fallback, so they tell nothing.

## Consequences

- No two processes hold one `FileLock` through a file that they cannot write. Such a file is a fault that the caller sees, not a lock that excludes nobody.
- Each `tryLock()` that gets the lock runs one more statement. It never waits.
- While another process holds the lock, `tryLock()` of a read-only handle still returns `false`: the statement of the journal fails with `SQLITE_BUSY` first. The `DeniedError` comes when the lock is free.
- The tests skip Windows and the root user. On Windows, Node.js sets the read-only attribute for a mode without the write bit, and SQLite falls back to read-only there too, but no test proves the refusal on Windows.

## Confirmation

- Probe, two processes, `FileLock.open` and `tryLock()` on one `0o444` file: both `true`, and `check` `'unlocked'` in each. With mode `0o644`: the second `tryLock()` is `false`, and `check` is `'locked'`.
- Probe, read-only fallback: `PRAGMA query_only` gives `0`; `BEGIN EXCLUSIVE`, `BEGIN IMMEDIATE` and an open with `mode=rw` succeed; `PRAGMA user_version = 0` in the transaction fails with `errcode` 8, "attempt to write a readonly database"; under a writable holder, the statement of the journal and `BEGIN EXCLUSIVE` fail with 5 first.
- Red, then green (`src/file-lock.test.ts`): "a file that the process can read but not write makes tryLock throw the DeniedError each time, not take a lock that no other process sees", and "two processes never both hold the lock of a file that they can read but not write". Before the fix, both failed with "Missing expected exception".
- Red, then green (`src/presence.test.ts`): "a presence file that the process can read but not write makes tryOpen and removeIfEnded throw the DeniedError at once, and the file stays". Before the fix, `removeIfEnded` rejected after 1 second with a plain `Error`, and `tryOpen` looped until the 5-second kill.
- Mutations: without the trial write, all three tests fail. Without the rollback before the throw, the first test fails: a second `tryLock()` says that the handle holds the lock. With the error of SQLite in place of the `DeniedError`, all three fail.
