# SQLite data version

Another process owns a SQLite database and writes it while it runs. This package tells when that process commits, so that a reader knows when to read again.

## Language

**Owner**:
The other process that owns the database and writes it. The owner keeps the file open, and commits through a WAL. The owner can also replace the file at the path.
_Avoid_: App, store, writer

**Data version**:
The number that `DataVersion` gives. It changes when another connection commits, or when the file at the path is a replaced file. Its value has no other meaning: compare it only with an earlier value from the same `DataVersion`. It is not the number of `PRAGMA data_version`, which is different on each connection.
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
SQLite cannot open the file, or the file system cannot give its times: the file is missing, or the system denies access. The package then throws `UnavailableError`. The caller can fix it, for example with a grant of access. Other failures are not unavailable.
_Avoid_: Not found, permission error
