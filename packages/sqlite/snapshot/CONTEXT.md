# SQLite snapshot

Another process owns a SQLite database and writes it while it runs. This package reads that database at one moment, so that the tables agree.

## Language

**Owner**:
The other process that owns the database and writes it. The owner keeps the file open. A WAL owner keeps a persistent WAL. An exclusive owner keeps the exclusive locking mode. A snapshot never writes to the database.
_Avoid_: App, store, writer (a snapshot is a reader of the owner, not of a writer in general)

**Snapshot**:
A read-only connection that holds one moment of the database with a read transaction. Each query of the snapshot sees that moment. The snapshot of an exclusive owner reads an owner copy.
_Avoid_: Copy, backup, app database

**Read transaction**:
The transaction that the snapshot starts with `BEGIN` and a first read. It holds the moment, and it stops the checkpoint of the owner until the snapshot is disposed.
_Avoid_: Lock, session

**Required columns**:
The columns that a reader needs, by table. When one is missing, the owner changed its layout, and a read would put fields in the wrong place.
_Avoid_: Schema version, migration

**Missing columns**:
The required columns that the layout of the owner does not have, as `table.column`. `requireColumns` then closes the snapshot and throws `MissingColumnsError`.
_Avoid_: Schema error, missing fields

**Unavailable**:
SQLite cannot open the file: the file is missing, or the system denies access. The package then throws `UnavailableError`, the class of `@zukhruf/sqlite-reader`. The caller can fix it, for example with a grant of access. Other failures are not unavailable.
_Avoid_: Not found, permission error

**Exclusive owner**:
An owner that holds SQLite's exclusive locking mode, with a rollback journal, as Chromium holds its History. It takes the lock at its first write and keeps it until it closes the database. No other connection can read the database while it holds the lock.
_Avoid_: Locked database, busy database (busy is the error code, not the owner)

**Owner copy**:
A clone of the database and the rollback journal of an exclusive owner, in a private folder, at one moment. The file stamps of both files were the same before and after the copy. The snapshot rolls back a hot journal in it, so it holds the last commit of the owner.
_Avoid_: Backup (the SQLite backup API is a different thing), snapshot (the snapshot reads the owner copy)

**Hot journal**:
A rollback journal that holds the pages of a transaction that the owner did not commit. SQLite rolls back a hot journal at the next read through a connection that can write.
_Avoid_: Open journal, dirty journal
