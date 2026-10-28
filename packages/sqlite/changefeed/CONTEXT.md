# SQLite changefeed

Another process owns a SQLite database and writes it while it runs. It gives no change log. This package reads that database read-only, and gives a change event for each changed row of each table.

## Language

**Owner**:
The other process that owns the database and writes it. The owner keeps the file open, and commits through a WAL. The owner can also replace the file at the path. The feed never writes to the file of the owner.
_Avoid_: App, source, writer, upstream

**Changefeed**:
The sequence of change events of one database, and the object that gives it (`Changefeed`). It reads each table, and it keeps its own position.
_Avoid_: Stream, subscription, CDC (use "change data capture" only for the method)

**Table**:
An entry of `PRAGMA table_list` with type `table` whose name does not start with `sqlite_`. A view, a virtual table and a shadow table are not tables of the feed. The feed reads each table in full.
_Avoid_: Stream, collection, query

**Key**:
The values that identify a row of a table: the identity that SQLite makes unique and not `NULL`. It is the declared primary key of a `WITHOUT ROWID` table, and the primary key of a rowid table when it is an `INTEGER PRIMARY KEY` or all its columns are `NOT NULL`. Each other table has the key `{ rowid }`.
_Avoid_: ID (an ID is one column), rowid (only one kind of key)

**Shadow table**:
A table that `PRAGMA table_list` gives with type `shadow`: it holds the data of a virtual table, for example `notes_fts_data` of an FTS5 table. It is internal to the module of the virtual table, and the feed does not read it.
_Avoid_: Backing table, index table

**Durable feed**:
A feed with a position file. Its first run gives each row as a read event. A later run goes on from the saved position. Delivery is at least once.
_Avoid_: Persistent feed, earliest

**Observing feed**:
A feed with no position file. Each `watch` takes a baseline when it starts, and then gives only the changes after it. It writes nothing to disk. A new run starts from a new baseline.
_Avoid_: Live feed, ephemeral feed, latest

**Baseline**:
The first pass of each `watch` of an observing feed. It reads each table and keeps the fingerprints in memory, and it gives no events.
_Avoid_: Initial scan, snapshot (a snapshot holds one moment of the database)

**Pass**:
One read of all tables in one snapshot. A pass compares the rows of each table with the position, and gives one batch.
_Avoid_: Scan (the word of `@zukhruf/snapshot-differential` for the rows of one table), sync, poll (a poll reads only the data version)

**Batch**:
The change events of one pass, as an array. The feed saves the position of a batch when the host asks for the next batch.
_Avoid_: Page, chunk, part (a part is a concept of `@zukhruf/snapshot-differential`)

**Change event**:
What a pass gives for one row: `{ table, op, key, after? }`. `op` is `read`, `insert`, `update` or `delete`. `after` is the full row, except for a `delete`. A truncate event is a change event too, but it is for a table, not for a row.
_Avoid_: Change (the word of `@zukhruf/snapshot-differential`), message, record

**Read event**:
A change event with `op: 'read'`. A pass gives it for each row of a table that the position does not have: each row at the first run of a durable feed, and each row of a new table. It is the `r` of Debezium.
_Avoid_: Insert, initial load, backfill

**Truncate event**:
A change event with `op: 'truncate'`: `{ table, op: 'truncate' }`. A pass gives it when the owner dropped a table, or changed the columns of its primary key. The host then removes all rows of the table from its copy. It is the `t` of Debezium.
_Avoid_: Reset, clear, drop

**Position**:
What the feed saw at its last saved batch: the key columns of each table, and one fingerprint for each row. A durable feed keeps it in its own SQLite file, at the path that the host gives. An observing feed keeps it in memory. It does not keep the rows.
_Avoid_: State, offset, checkpoint (a checkpoint copies the WAL of the owner into its file), cursor, snapshot (a snapshot holds one moment of the database)

**Save**:
The write of the position of a batch by a durable feed, in one transaction. It occurs when the host asks for the next batch.
_Avoid_: Commit (a commit is what the owner does), ack, flush

**Net change**:
The difference between the rows of a table at two passes. A pass sees only the net change. A row that the owner inserts and deletes between two passes is not in it.
_Avoid_: Commit, transaction, history

**Unavailable**:
SQLite cannot open the database: the file is missing, or the system denies access. The package then throws `UnavailableError`. The host can fix it, for example with a grant of access. Other failures are not unavailable.
_Avoid_: Not found, permission error
