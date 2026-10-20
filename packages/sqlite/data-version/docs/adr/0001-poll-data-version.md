# Poll data_version

A reader of a database that another process, the owner, writes must know when to read again. The owner keeps the file open, and it commits through a persistent WAL.

A file-change event, for example from FSEvents, reports a write only when the file closes. The owner does not close the file while it runs. Thus a reader that waits for an event can miss many commits.

SQLite gives `PRAGMA data_version`. On one connection, the number changes after each commit by another connection. It is the same for commits that go only into the WAL. Thus `DataVersion` keeps its own read-only connection, and a caller polls `current`.

The connection is its own, and it is not the connection of a snapshot. A snapshot holds one moment, and it is held only while it reads. The poll runs all the time, so it must not hold a read transaction: an open read stops the checkpoint of the owner. A `PRAGMA data_version` outside a transaction holds nothing after it returns.

This decision moved from context-compiler (commit 3a1c829, `AppDatabaseVersion`).

## Considered Options

- **Watch the file with file-change events.** It needs no polling. But the event comes only when the file closes, and the owner keeps it open.
- **Compare the size or the time of change of the files.** The WAL can keep its size while the owner writes, and the time of change has a coarse resolution on some file systems.
- **Poll `PRAGMA data_version` on the connection of a snapshot.** A snapshot holds a read transaction, and a long poll then stops the checkpoint of the owner.
- **Poll `PRAGMA data_version` on its own read-only connection.** This option was selected.

## Consequences

- A caller sees each commit of the owner at the next poll, also when the owner keeps the file open.
- A caller chooses the interval of the poll. A short interval costs one small statement each time.
- The number does not tell what changed. A caller reads again to know.
