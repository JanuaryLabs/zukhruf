# SQLite data version

Another process owns a SQLite database and writes it while it runs. This package tells when that process commits, so that a reader knows when to read again.

## Language

**Owner**:
The other process that owns the database and writes it. The owner keeps the file open, and commits through a WAL or a rollback journal. The owner can also replace the file at the path.
_Avoid_: App, store, writer

**Data version**:
The number that `DataVersion` gives. It changes when another connection commits, or when the file at the path is a replaced file. For an exclusive owner, it changes when the file stamp of the database file changes. Its value has no other meaning: compare it only with an earlier value from the same `DataVersion`. It is not the number of `PRAGMA data_version`, which is different on each connection. A change watcher of `@zukhruf/async` reads it as a gauge.
_Avoid_: Revision, counter, schema version (`PRAGMA schema_version` is a different number)

**Commit by another connection**:
A commit that a different connection to the same database makes, for example a commit of the owner. Only such a commit changes the data version.
_Avoid_: Change event, file change

**Replaced file**:
The path names a file with a different device and inode than the file of the open connection. The owner replaces a file when it renames a new file over the path, or when it deletes the file and creates it again.
_Avoid_: Moved file, recreated database, new inode

**Last write**:
The time when the owner last wrote the database: the later of the modification times of the file and its WAL, when the WAL holds frames. An empty WAL does not count, because a reader makes one when the owner removed the WAL. The shared-memory index does not count, because a reader writes it too.
_Avoid_: Modified time, mtime, last update

**Unavailable**:
SQLite cannot open the file, or the file system cannot give its times: the file is missing, or the system denies access. The package then throws `UnavailableError`, the class of `@zukhruf/sqlite-open`. The caller can fix it, for example with a grant of access. Other failures are not unavailable. The package exports the two subclasses of `UnavailableError` (commit 14539105, [ADR 0008 of `@zukhruf/sqlite-open`](../open/docs/adr/0008-a-missing-file-and-a-denied-file-are-two-classes.md)):

- `MissingError`: the file, or a folder on its path, is not there (`ENOENT`, `ENOTDIR`).
- `DeniedError`: the system keeps this process from the file, or from a folder on its path (`EACCES`, `EPERM`, or SQLite's `SQLITE_READONLY_DIRECTORY`, 1544).

When the error does not say which, the package throws a plain `UnavailableError`.
_Avoid_: Not found, permission error

**Exclusive owner**:
An owner that holds SQLite's exclusive locking mode, with a rollback journal, as Chromium holds its History. No other connection can read the database while it holds the lock, so no connection can read `PRAGMA data_version`.
_Avoid_: Locked database, busy database (busy is the error code, not the owner)

**File stamp**:
What the file system says about the file at a path: its device, its inode, its size, and the times of its last write and its last change, to the nanosecond. It is the `FileStamp` of `@zukhruf/fs`. For an exclusive owner, the data version changes when the file stamp of the database file changes ([ADR 0004](./docs/adr/0004-the-version-of-an-exclusive-owner-is-the-stamp-of-its-database-file.md)).
_Avoid_: Fingerprint (a hash of the content), mtime (one part of the stamp), checksum
