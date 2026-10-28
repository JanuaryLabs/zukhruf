# Capture by snapshot differential

A reader wants each change to the rows of a SQLite database. Another process, the owner, writes the database while it runs. The reader runs in a different process. It cannot change the owner, and it must not write to the file of the owner. The owner gives no change log.

Change data capture has two families. Log-based capture reads the log of the database, as Debezium does. Query-based capture reads the data and compares it with the last read, as the Kafka Connect JDBC source and Fivetran Teleport Sync do.

## Decision

The feed captures by query. Each pass reads each table in one snapshot, and `@zukhruf/snapshot-differential` compares the rows with the position of the last saved batch (Labio and Garcia-Molina, "Efficient Snapshot Differential Algorithms for Data Warehousing", VLDB 1996). The deletion policy is `ClosedWorld`: a pass reads each row of a table, so a key that the pass does not find was deleted.

`DataVersion` of `@zukhruf/sqlite-data-version` tells when to make a pass. A pass occurs only when the data version changed.

elt runs this composition in production for 14 databases of macOS apps. This package moves it into one place.

## Considered Options

- **Read the WAL for the rows.** The WAL holds whole pages of the b-tree, not rows. A page has no name of its table: a reader must walk each b-tree from `sqlite_schema` to find the table of a page. A checkpoint restart writes the WAL again from its start, and the frames that the reader did not read yet are gone. SQLite does not give this format as an API.
- **Triggers.** A trigger writes each change into a log table. It writes into the file of the owner, and it changes the schema of the owner. The owner can drop it, or fail on it, at its next migration.
- **The session extension, or `sqlite3_update_hook`.** They give each change, but only to the connection that makes the change. They run only inside the process of the owner.
- **Incrementing or timestamp columns.** A query asks only for rows with an `id` or an `updated_at` above the last value, as the `incrementing` and `timestamp` modes of the Kafka Connect JDBC source do. It reads less. But it does not see a hard delete on its own, and many tables of an owner have no such column.
- **A snapshot differential of each table.** This option was selected.

### For later: read again only the tables that changed

A pass reads each table, also when the commit of the owner changed one row. A later version can read the page numbers of the WAL frames that the owner wrote since the last pass, find the table of each page with the `dbstat` virtual table, and read again only those tables. The page numbers are in the header of each frame, so the feed does not need to read the content of a page. A checkpoint restart writes the WAL again from its start, and the frames before it are gone. The feed then makes a full pass. This option assumes the format of the WAL, so it is an optimization, not the method of capture.

## Consequences

- The feed needs no change in the owner, and it never writes to the file of the owner.
- A pass sees only the net change. A row that the owner inserts and deletes between two passes gives no event.
- Each pass reads each table in full. The cost grows with the size of the database.
- The position keeps one fingerprint for each row.
- `@zukhruf/snapshot-differential` must give `insert` and `update` in place of `upsert` ([ADR 0003](./0003-the-change-event.md)).
- `@zukhruf/snapshot-differential` must fingerprint binary values (`Uint8Array`, `Buffer`) in its canonical form. Today it throws a `TypeError` for a value that JSON cannot hold with no change, and SQLite gives a `BLOB` as a `Uint8Array`. It must also accept bytes in a key: `KeyValue` gains `Uint8Array`. A record of each differential can hold bytes, so this is a need of the differential, not of this package. Then `after` and a key keep a `BLOB` as its `Uint8Array`.
- A pass copies each row into a plain object, because `node:sqlite` gives rows with no prototype, and the differential accepts only plain objects.
