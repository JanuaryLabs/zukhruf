# SQLite data version

Another process owns a SQLite database and writes it while it runs. This package tells when that process commits, so that a reader knows when to read again.

## Language

**Owner**:
The other process that owns the database and writes it. The owner keeps the file open, and commits through a WAL.
_Avoid_: App, store, writer

**Data version**:
The number that `PRAGMA data_version` gives on one connection. It changes when another connection commits. Its value has no other meaning: compare it only with an earlier value from the same connection.
_Avoid_: Revision, counter, schema version (`PRAGMA schema_version` is a different number)

**Commit by another connection**:
A commit that a different connection to the same database makes, for example a commit of the owner. Only such a commit changes the data version.
_Avoid_: Change event, file change

**Unavailable**:
SQLite cannot open the file: the file is missing, or the system denies access. The caller can fix it, for example with a grant of access. Other failures are not unavailable.
_Avoid_: Not found, permission error
