# Never immutable, and held only while reading

A snapshot reads a database that another process, the owner, writes while it runs. The owner keeps a persistent WAL. Thus the newest commits can be in the WAL file, and not yet in the database file.

SQLite can open a file with `immutable=1`. Then it reads only the database file. It skips the locks and the WAL. That is correct only for a file that nobody writes. On a file of the owner, an immutable reader does not see the newest rows, and it can read a page while the owner changes it.

Thus a snapshot opens the file read-only, but never immutable. It runs `BEGIN` and a first read at once. Then the read transaction holds one moment, and each query sees the same moment, so the tables agree.

An open read transaction has a cost to the owner. A checkpoint copies the WAL into the database file, and it cannot go past the end mark of an open read. While a snapshot is open, the WAL of the owner grows. Thus a caller holds a snapshot only while it reads, and disposes it at once.

This decision moved from context-compiler (commit 3a1c829, `AppDatabase`).

## Considered Options

- **Open with `immutable=1`.** It needs no locks, and it never blocks the owner. But it does not read the WAL, so it misses the newest rows. It also has no protection while the owner writes.
- **Read without a transaction.** Each statement sees the moment when it starts. Two queries can see two different moments, and the tables do not agree.
- **Copy the file, and read the copy.** A copy of the database file without its WAL misses the newest rows too. A copy of both files is not atomic while the owner writes.
- **A read-only connection with a read transaction, held only while reading.** This option was selected.

## Consequences

- A snapshot sees the newest commit at the moment when it opens, and nothing after that moment.
- A caller that reads again later opens a new snapshot.
- A snapshot that a caller forgets to dispose makes the WAL of the owner grow.
