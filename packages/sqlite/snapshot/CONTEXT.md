# SQLite snapshot

Another process owns a SQLite database and writes it while it runs. This package reads that database at one moment, so that the tables agree.

## Language

**Owner**:
The other process that owns the database and writes it. The owner keeps the file open and keeps a persistent WAL. A snapshot never writes to the database.
_Avoid_: App, store, writer (a snapshot is a reader of the owner, not of a writer in general)

**Snapshot**:
A read-only connection that holds one moment of the database with a read transaction. Each query of the snapshot sees that moment.
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
SQLite cannot open the file: the file is missing, or the system denies access. The package then throws `UnavailableError`. The caller can fix it, for example with a grant of access. Other failures are not unavailable.
_Avoid_: Not found, permission error
