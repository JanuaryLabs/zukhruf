# WAL is required

A pass reads the database of the owner while the owner runs. The feed must not stop the owner.

SQLite has two kinds of journal. In WAL mode, readers do not block writers, and a writer does not block readers ("Write-Ahead Logging" in the SQLite documentation). In a rollback-journal mode (`delete`, `truncate`, `persist`, `memory`, `off`), a reader holds a shared lock while it reads. The owner cannot commit until each shared lock is released. A pass reads each table in full, so a pass in a rollback-journal mode can stop the commits of the owner for the time of the full read.

## Decision

The feed reads `PRAGMA journal_mode` when it opens the database. Each value other than `wal` throws `JournalModeError`. The error has the `path` and the `journalMode` that SQLite gave.

The feed reads the mode again at each pass. `DataVersion` follows a replaced file ([sqlite-data-version ADR 0002](../../../data-version/docs/adr/0002-a-replaced-file-is-followed-by-name.md)), and the new file can have a different mode.

A pass holds its read transaction only while it reads. The poll between two passes holds no read transaction ([sqlite-data-version ADR 0001](../../../data-version/docs/adr/0001-poll-data-version.md)): an open read stops the checkpoint of the owner, and the WAL of the owner then grows.

The feed never sets the journal mode. A change of the mode is a write to the file of the owner.

## Considered Options

- **Accept each mode.** A pass in a rollback-journal mode can stop the commits of the owner. The owner can then fail with `SQLITE_BUSY`, or stop its UI.
- **Accept a rollback-journal mode, and read in small parts.** Each part releases the shared lock. The parts then come from different moments, and the tables do not agree.
- **Copy the file, and read the copy.** A copy also needs a shared lock for the time of the copy.
- **Set `journal_mode = WAL`.** It writes to the file of the owner, and it changes how the owner works.
- **Require WAL, and throw `JournalModeError` for each other mode.** This option was selected.

## Consequences

- The feed never stops a commit of the owner.
- A database in a rollback-journal mode cannot have a feed. The host gets `JournalModeError` at once, not a slow owner later.
- Each pass runs one more small statement.
