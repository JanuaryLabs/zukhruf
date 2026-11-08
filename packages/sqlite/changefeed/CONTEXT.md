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
A feed whose position is a position file (`PositionFile`). A later run goes on from the saved position. Delivery is at least once.
_Avoid_: Persistent feed, earliest

**Start**:
What the first pass gives for each table, until a pass saves the position (`Start`). The host gives it to the feed. `ReadEveryRow` gives a read event for each row. `Baseline` gives a baseline.
_Avoid_: Offset reset, snapshot mode, earliest, latest

**Baseline**:
A first pass that keeps the fingerprint of each row of each table, and gives no events (`Baseline`). Later passes give only the changes after it.
_Avoid_: Initial scan, snapshot (a snapshot holds one moment of the database)

**Pass**:
One read of all tables in one snapshot. A pass compares the rows of each table with the position, and gives one batch.
_Avoid_: Scan (the word of `@zukhruf/snapshot-differential` for the rows of one table), sync, poll (a poll reads only the data version)

**Batch**:
The change events of one pass (`Batch`). The feed saves the position of a batch when the host asks for the next batch.
_Avoid_: Page, chunk, part (a part is a concept of `@zukhruf/snapshot-differential`)

**Sequence**:
The number of the save that keeps a batch of a durable feed (`SequencedBatch.sequence`). A batch that comes again after a stop has the same sequence. A feed whose position is in memory gives no sequence.
_Avoid_: Offset, ID, version

**Changed columns**:
The columns whose values an update changed (`changed`). It is never empty. A new or a dropped column is a changed column of each row.
_Avoid_: Diff, delta, before

**WAL progress**:
How far a pass read the owner's WAL: the salt of its header and the number of frames up to its last commit. A reset of the WAL changes the salt.
_Avoid_: Offset, checkpoint (a checkpoint copies the WAL into the file of the owner), cursor

**Change event**:
What a pass gives for one row: `{ table, op, key, after? }`. `op` is `read`, `insert`, `update` or `delete`. `after` is the full row, except for a `delete`. A truncate event is a change event too, but it is for a table, not for a row.
_Avoid_: Change (the word of `@zukhruf/snapshot-differential`), message, record

**Read event**:
A change event with `op: 'read'`. A pass gives it for each row of a table that the position does not have: each row of the first pass when the start is `ReadEveryRow`, and each row of a new table after the first save. It is the `r` of Debezium.
_Avoid_: Insert, initial load, backfill

**Truncate event**:
A change event with `op: 'truncate'`: `{ table, op: 'truncate' }`. A pass gives it when the owner dropped a table, or changed the columns of its primary key. The host then removes all rows of the table from its copy. It is the `t` of Debezium.
_Avoid_: Reset, clear, drop

**Position**:
What the feed saw at its last saved batch: the key columns and the columns of each table, one hash for each column of each row, and the WAL progress (`Position`). The host gives it to the feed, and the feed owns it. A `PositionFile` keeps it in its own SQLite file, at the path that the host gives. A `PositionInMemory` keeps it in memory. It does not keep the rows. A position that no pass saved is not started.
_Avoid_: State, offset, checkpoint (a checkpoint copies the WAL of the owner into its file), cursor, snapshot (a snapshot holds one moment of the database)

**Save**:
The write of the position of a batch, in one transaction. It occurs when the host asks for the next batch. The first save starts the position.
_Avoid_: Commit (a commit is what the owner does), ack, flush

**Net change**:
The difference between the rows of a table at two passes. A pass sees only the net change. A row that the owner inserts and deletes between two passes is not in it.
_Avoid_: Commit, transaction, history

**Unavailable**:
SQLite cannot open the database: the file is missing, or the system denies access. The package then throws `UnavailableError`. The host can fix it, for example with a grant of access. Other failures are not unavailable.
_Avoid_: Not found, permission error
