# An exclusive owner is read from a checked copy

Some owners let no reader in. Chromium opens each database with SQLite's exclusive locking mode: `sql::Database` has `exclusive_locking_ = true` as its default (`sql/database.h`), and the History database keeps it. Chrome, Edge, Brave, Arc and Dia all keep their History this way. The owner takes the lock at its first write and keeps it until it closes the database. A snapshot opens the file read-only, and its first read fails with `SQLITE_BUSY` (5), "database is locked". A probe on 2026-11-02 showed this on the History of a running Dia.

Such an owner uses a rollback journal, not a WAL. Before it writes a page of the database file, it puts the old page in the journal. While a transaction is open, the database file can hold pages that the owner did not commit, and the journal is hot: it holds the pages that bring back the last commit.

[ADR 0001](./0001-never-immutable-and-held-only-while-reading.md) rejected a copy for an owner that keeps a WAL. It gave two reasons: a copy of the database file without its WAL misses the newest commits, and a copy of two files is not atomic while the owner writes. For an exclusive owner, the first reason does not apply: no WAL exists, and each commit is in the database file. The second reason applies, and the copy must answer it.

## Decision

`Snapshot.ofExclusiveOwner(path)` reads an owner copy:

1. It reads the file stamps of the database and its journal (`@zukhruf/fs`).
2. It clones the database and the journal into a private folder. APFS and Btrfs make a clone that takes no time and no space. Other file systems copy the bytes.
3. It reads the file stamps again. When they changed, the owner wrote during the copy. Then it tries again at once, up to 5 times, and after that it throws `DatabaseChangingError`.
4. It opens the copy for writing one time, and reads. SQLite then rolls back a hot journal in the copy. The copy holds the last commit of the owner, and no page of an open transaction.
5. The snapshot reads the copy with the usual read transaction. Its dispose deletes the private folder.

The snapshot never writes a file of the owner. A journal that a dead owner left stays as it is, for the owner to roll back when it opens the database again.

The tries do not wait. A commit writes the journal and the database file with syncs between them, so the next copy usually lands in a quiet moment. A wait would need the clock as an input ([root ADR 0004](../../../../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md)).

## Considered Options

- **Open with `immutable=1`.** SQLite skips the locks and the journal. It then reads the pages that the owner did not commit, and it can read a page while the owner writes it.
- **Copy the database file only.** The copy holds the pages of an open transaction, and no journal can roll them back.
- **Copy the database and the journal with no check.** A write during the copy gives a database and a journal from two moments.
- **The SQLite backup API.** It reads through a connection, which takes a lock, and fails with `SQLITE_BUSY`.
- **A checked copy, rolled back in the private folder.** This option was selected. yt-dlp also reads the databases of Chromium from a copy (`_open_database_copy` in `cookies.py`).

## Consequences

- `@zukhruf/sqlite-snapshot` depends on `@zukhruf/fs` for the file stamps.
- On a file system with no clone, each snapshot copies the whole database. A History file of Chromium is about 23 MB.
- A snapshot holds the last commit of the owner. Chromium commits its History about every 10 seconds, so the newest visits can be missing from it.
- A test cannot force a write between the two stamps without a hook in the code. Also, an owner that never stops still pauses when the system runs other work, and a copy in a pause holds one whole commit. Thus the tests check that each snapshot holds whole commits or fails with `DatabaseChangingError`, while an owner commits every 3 ms and while an owner commits without end. No test can force the fifth failed copy.
