# SQLite reader

Another process owns a SQLite database and writes it while it runs. This package opens a read-only connection to that database. When the open fails for a cause that the caller can fix, the package names that failure.

## Language

**Owner**:
The other process that owns the database and writes it. The owner keeps the file open, and can keep a WAL. A reader never writes to the database.
_Avoid_: App, store, writer

**Reader**:
A read-only connection to the database of the owner. `openReader` opens it. The SQLite documentation uses this word for a connection that reads ("Write-Ahead Logging").
_Avoid_: Client, consumer, handle

**Unavailable**:
SQLite cannot open the file: the file is missing, or the system denies access. The package then throws `UnavailableError`. The caller can fix it, for example with a grant of access. Other failures are not unavailable.
_Avoid_: Not found, permission error
