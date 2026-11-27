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
The transaction that the snapshot starts with `BEGIN` and a first read. It holds the moment, and it stops the WAL checkpoint of the owner until the snapshot is disposed.
_Avoid_: Lock, session

**WAL checkpoint**:
The step in which SQLite moves the pages of the WAL back into the database, as "Write-Ahead Logging" in the SQLite documentation (https://www.sqlite.org/wal.html) defines it. A WAL checkpoint stops at the end mark of each open read transaction, so the WAL of the owner grows while a snapshot is open.
_Avoid_: Checkpoint alone (the saved progress of a reader, in @zukhruf/checkpoint), flush, sync, commit (a commit writes to the WAL, a WAL checkpoint writes from it)

**Layout**:
The tables of the database of the owner and the columns of each table, as `pragma_table_info` gives them. The owner can change its layout from one version to the next.
_Avoid_: Schema (`sqlite_schema` holds the full `CREATE` statements, not only the columns), format

**Required columns**:
The columns that a reader needs, by table. When one is missing, the owner changed its layout, and a read would put fields in the wrong place.
_Avoid_: Schema version, migration

**Missing columns**:
The required columns that the layout of the owner does not have, as `table.column`. `requireColumns` then closes the snapshot and throws `MissingColumnsError`.
_Avoid_: Schema error, missing fields

**Unavailable**:
SQLite cannot open the file: the file is missing, or the system denies access. The package then throws `UnavailableError`, the class of `@zukhruf/sqlite-open`. The caller can fix it, for example with a grant of access. Other failures are not unavailable.
_Avoid_: Not found, permission error

**Exclusive owner**:
An owner that holds SQLite's exclusive locking mode, with a rollback journal, as Chromium holds its History. It takes the lock at its first write and keeps it until it closes the database. No other connection can read the database while it holds the lock.
_Avoid_: Locked database, busy database (busy is the error code, not the owner)

**Owner copy**:
A clone of the database and the rollback journal of an exclusive owner, in a private folder, at one moment. The file stamps of both files were the same before and after the copy. The snapshot rolls back a hot journal in it, so it holds the last commit of the owner.
_Avoid_: Backup (the SQLite backup API is a different thing), snapshot (the snapshot reads the owner copy)

**File stamp**:
What the file system says about the file at a path, as `FileStamps` of `@zukhruf/fs` reads it: its device, its inode, its size and the times of its last write and its last change. A write to the file changes its stamp. A missing file has a stamp of its own, so a rollback journal that appears or disappears changes the stamps too.
_Avoid_: Fingerprint (a hash of the content), checksum, mtime (one part of the stamp)

**Hot journal**:
A rollback journal that holds the pages of a transaction that the owner did not commit. SQLite rolls back a hot journal at the next read through a connection that can write.
_Avoid_: Open journal, dirty journal
