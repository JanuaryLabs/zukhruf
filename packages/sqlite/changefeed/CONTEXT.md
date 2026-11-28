# SQLite changefeed

Another process owns a SQLite database and writes it while it runs. It gives no change log. This package reads that database read-only, and gives a change event for each changed row of each table.

## Language

**Owner**:
The other process that owns the database and writes it. The owner keeps the file open, and commits through a WAL. The owner can also replace the file at the path. The feed never writes to the file of the owner.
_Avoid_: App, source, writer, upstream

**Changefeed**:
The sequence of change events of one database, and the object that gives it (`Changefeed`). Each pass reads the tables that changed. The feed keeps what it saw in a checkpoint of `@zukhruf/checkpoint`, and the host commits it.
_Avoid_: Stream, subscription, CDC (use "change data capture" only for the method)

**Table**:
An entry of `PRAGMA table_list` with type `table` whose name does not start with `sqlite_`. A view, a virtual table and a shadow table are not tables of the feed. When the feed reads a table, it reads all its rows.
_Avoid_: Stream, collection, query

**Key**:
The values that identify a row of a table: the identity that SQLite makes unique and not `NULL`. It is the declared primary key of a `WITHOUT ROWID` table, and the primary key of a rowid table when it is an `INTEGER PRIMARY KEY` or all its columns are `NOT NULL`. Each other table has the key `{ rowid }`.
_Avoid_: ID (an ID is one column), rowid (only one kind of key)

**Fingerprint**:
The hashes of the columns of one row: one hash for each column, in the order of the columns of the table. Each hash is the first 8 bytes of a SHA-256 of the value. The checkpoint keeps one fingerprint for each key of each table, in the map state `table:<name>`, and does not keep the row. Two fingerprints of a row tell which columns an update changed.
_Avoid_: Checksum, digest, row hash (a fingerprint has one hash for each column)

**Shadow table**:
A table that `PRAGMA table_list` gives with type `shadow`: it holds the data of a virtual table, for example `notes_fts_data` of an FTS5 table. It is internal to the module of the virtual table, and the feed does not read it.
_Avoid_: Backing table, index table

**Durable feed**:
A feed whose consumer group has a store that lasts past the process, such as a `SqliteCheckpointStore`. A later run goes on from the last commit. Delivery is at least once, and exactly once when the host commits its output in the `write` of the commit.
_Avoid_: Persistent feed, earliest

**Start**:
What the first pass gives for each table while the feed's partition has no checkpoint (`Start`). The host gives it to the feed. `ReadEveryRow` gives a read event for each row. `Baseline` gives a baseline.
_Avoid_: Offset reset, snapshot mode, earliest, latest

**Baseline**:
A first pass that keeps the fingerprint of each row of each table, and gives no events (`Baseline`). Later passes give only the changes after it.
_Avoid_: Initial scan, snapshot (a snapshot holds one moment of the database)

**Pass**:
One read of the tables in one snapshot. A pass reads each table that the owner's WAL frames wrote since the last pass, and each table that the feed did not see. When it cannot tell which tables the frames wrote, it is a full pass. A pass compares the rows of each table that it reads with the fingerprints of the checkpoint and of the batches given since, and gives one batch (`src/pass.ts`). See [ADR 0011](docs/adr/0011-a-pass-reads-the-tables-that-the-wal-frames-wrote.md).
_Avoid_: Scan (the word of `@zukhruf/snapshot-differential` for the rows of one table), sync, poll (a poll reads only the data version)

**Full pass**:
A pass that reads each table, because it cannot tell which tables changed: the first pass, a pass when the owner has no WAL, after a reset of the WAL, when the WAL holds fewer frames than the WAL progress, or when a frame wrote a page of the schema. Its cost grows with the size of the database, also when the owner changed one row. See [ADR 0011](docs/adr/0011-a-pass-reads-the-tables-that-the-wal-frames-wrote.md).
_Avoid_: Full scan, resync

**Poll**:
One read of the data version of the database (`DataVersion` of `@zukhruf/sqlite-data-version`). `watch` polls each `interval` milliseconds, and makes a pass only when the data version changed. A poll reads no rows.
_Avoid_: Pass (a pass reads the rows of tables), scan, tick

**Batch**:
The change events of one pass: a `readonly ChangeEvent[]`, an empty one too. A commit saves every batch that the watch gave so far.
_Avoid_: Page, chunk, part (a part is a concept of `@zukhruf/snapshot-differential`)

**Changed columns**:
The columns whose values an update changed (`changed`). It is never empty. A new or a dropped column is a changed column of each row.
_Avoid_: Diff, delta, before

**WAL progress**:
How far a pass read the owner's WAL: the salt of its header and the number of frames up to its last commit. A reset of the WAL changes the salt.
_Avoid_: Offset, cursor, WAL checkpoint (a WAL checkpoint copies the WAL into the file of the owner)

**Change event**:
What a pass gives for one row: `{ table, op, key, after? }`. `op` is `read`, `insert`, `update` or `delete`. `after` is the full row, except for a `delete`. A truncate event is a change event too, but it is for a table, not for a row.
_Avoid_: Change (the word of `@zukhruf/snapshot-differential`), message, record

**Read event**:
A change event with `op: 'read'`. A pass gives it for each row of a table that the feed did not see: each row of the first pass when the start is `ReadEveryRow`, and each row of a new table after the first pass. It is the `r` of Debezium.
_Avoid_: Insert, initial load, backfill

**Truncate event**:
A change event with `op: 'truncate'`: `{ table, op: 'truncate' }`. A pass gives it when the owner dropped a table, or changed the columns of its primary key. The host then removes all rows of the table from its copy. It is the `t` of Debezium.
_Avoid_: Reset, clear, drop

**Checkpoint**:
What the feed saw, kept for one consumer group, one stream and partition `'0'` (`@zukhruf/checkpoint`; see its [glossary](../../checkpoint/CONTEXT.md)). Its position is the WAL progress. Its map state `tables` holds the key columns and the columns of each table, and its map state `table:<name>` holds one fingerprint for each key. The host gives the consumer group and the stream, and owns the store. It does not keep the rows. A partition with no checkpoint gets the start.
_Avoid_: State, offset, cursor, position file, snapshot (a snapshot holds one moment of the database), WAL checkpoint (it copies the WAL of the owner into its file)

**Claim**:
What `watch()` does first: it takes the partition of the stream with a new epoch, and reads its checkpoint. A newer claim fences the older one, so the commit of an older feed rejects with `CheckpointFencedError`.
_Avoid_: Lock, lease, open

**Commit**:
The write of every batch that the watch gave so far, all of it or none of it (`commit()`). With `write`, the host's output commits in the same transaction. The host calls it after it applied a batch.
_Avoid_: Save, ack, flush (a commit of the owner is a commit of its database, not of the feed)

**Net change**:
The difference between the rows of a table at two passes. A pass sees only the net change. A row that the owner inserts and deletes between two passes is not in it.
_Avoid_: Commit, transaction, history

**Unavailable**:
SQLite cannot open the database: the file is missing, or the system denies access. The package then throws `UnavailableError`. The host can fix it, for example with a grant of access. Other failures are not unavailable.
_Avoid_: Not found, permission error
