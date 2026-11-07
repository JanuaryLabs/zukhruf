# @zukhruf/sqlite-changefeed

Some programs keep their data in a SQLite database, and write it while they run. The owner gives no change log and no API. Another program wants each change to the rows, so that it can copy them into a different store. This package gives a changefeed of the database: a change event for each changed row of each table, by the primary key of the row. It reads the database read-only, and it never writes to the file of the owner. It is change data capture by query, also known as a snapshot differential (Labio and Garcia-Molina, VLDB 1996).

The feed composes four packages:

- `@zukhruf/sqlite-data-version` tells when to read again. Its `DataVersion` changes when the owner commits, and it follows a replaced file.
- `@zukhruf/sqlite-snapshot` holds one moment for each pass. All tables of a pass come from the same moment.
- `@zukhruf/snapshot-differential` tells what changed since the last pass.
- The change watcher of `@zukhruf/async` polls the data version, and starts a pass only when it changes.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment. It uses only `node:sqlite`.

```sh
npm install @zukhruf/sqlite-changefeed
```

The owner is a notes app. It keeps its database in WAL mode. The reader copies each table into its own store:

```ts
import {
  Baseline,
  Changefeed,
  PositionFile,
  ReadEveryRow,
} from '@zukhruf/sqlite-changefeed';

using feed = new Changefeed(
  `${process.env.HOME}/Library/Application Support/Notes/notes.sqlite`,
  {
    position: new PositionFile(
      `${process.env.HOME}/.notes-copy/notes.position.sqlite`,
    ),
    start: new ReadEveryRow(),
  },
);

const stop = new AbortController();
process.once('SIGINT', () => stop.abort());

for await (const batch of feed.watch({
  interval: 1_000,
  signal: stop.signal,
  clock: globalThis,
})) {
  for (const event of batch) {
    if (event.op === 'truncate') await store.clear(event.table);
    else if (event.op === 'delete') await store.remove(event.table, event.key);
    else await store.put(event.table, event.key, event.after);
  }
  // The feed saves the position of this batch when the loop asks for the next one.
}
```

The feed gets two objects. The position tells where the feed keeps what it saw. The start tells what the first pass gives. This is a durable feed: its position is a file, and a new run goes on from the last saved batch. Its start is `ReadEveryRow`, so the first run gives each row as a read event.

A host that sends a message for each change does not want the rows that were there before it started. Give it the start `Baseline`. The first pass is then a baseline: it keeps the fingerprints, and gives no events. A position file keeps the baseline, so a new run gives the changes that the owner made while the feed was stopped:

```ts
using feed = new Changefeed(
  `${process.env.HOME}/Library/Application Support/Notes/notes.sqlite`,
  {
    position: new PositionFile(
      `${process.env.HOME}/.notes-alerts/notes.position.sqlite`,
    ),
    start: new Baseline(),
  },
);

for await (const batch of feed.watch({
  interval: 1_000,
  signal: stop.signal,
  clock: globalThis,
})) {
  for (const event of batch) console.log(event.table, event.op, event.key);
}
```

With `ReadEveryRow`, the first run gives a `read` event for each row of each table. Each later batch gives only the rows that changed. Each integer is a `bigint`:

```
{ table: 'notes',  op: 'read',   key: { id: 1n }, after: { id: 1n, folder_id: 7n, title: 'Plan', body: '…' } }
{ table: 'tags',   op: 'read',   key: { rowid: 3n }, after: { note_id: 1n, tag: 'q4' } }
…
{ table: 'notes',  op: 'update', key: { id: 1n }, after: { id: 1n, folder_id: 7n, title: 'Plan v2', body: '…' } }
{ table: 'tags',   op: 'delete', key: { rowid: 3n } }
{ table: 'drafts', op: 'truncate' }
```

The table `tags` has no primary key, so its key is the `rowid`. The owner dropped the table `drafts`, so the feed gives a `truncate` for it.

## The rules

- The database must be in WAL mode. `new Changefeed(databasePath, { position, start })` reads `PRAGMA journal_mode`, and throws `JournalModeError` for each other mode. Each pass reads it again, because the owner can replace the file. [ADR 0002](./docs/adr/0002-wal-is-required.md) tells why.
- The feed reads each table that `PRAGMA table_list` gives with type `table`, except a name that starts with `sqlite_`. It does not read an internal table of SQLite (`sqlite_schema`, `sqlite_sequence`, `sqlite_stat*`), a `view`, a `virtual` table, or a `shadow` table. A shadow table holds the data of a virtual table, for example the `notes_fts_data` of an FTS5 table. It is internal to the module of the virtual table. [ADR 0006](./docs/adr/0006-every-table-keyed-by-its-primary-key.md) tells why.
- The key of a row is the identity that SQLite makes unique and not `NULL`. The feed finds it from the schema of each table:
  - A `WITHOUT ROWID` table: its declared primary key. SQLite makes each column of it `NOT NULL`, and `PRAGMA table_info` gives `notnull` 1 for each column of it.
  - A rowid table with an `INTEGER PRIMARY KEY` that is an alias of the `rowid`, or with a primary key whose columns are all declared `NOT NULL`: that primary key. `id INTEGER PRIMARY KEY DESC` in a column definition is not an alias of the `rowid`, and can hold `NULL`.
  - Each other rowid table: the key `{ rowid }`. A declared primary key of a rowid table can hold `NULL` in many rows, so it does not identify a row.
  - The columns of a primary key are the columns of `PRAGMA table_info` with a `pk` above 0, in the order of `pk`.
- `VACUUM` can change the `rowid` of each row of a table with no primary key. The feed compares the rows by `rowid`, so it then gives an event for each `rowid` whose row changed: an `insert` for a new `rowid`, an `update` for a `rowid` that now holds a different row, and a `delete` for a `rowid` that is gone. The SQLite documentation advises an `INTEGER PRIMARY KEY` for a stable `rowid`.
- A pass copies each row into a plain object, because `node:sqlite` gives rows with no prototype. `after` keeps the values that SQLite gives: a `bigint` for an `INTEGER`, a number for a `REAL`, a string, `null`, or a `Uint8Array` for a `BLOB`. A key value is a `bigint` for an `INTEGER` too, such as each `rowid`. [ADR 0008](./docs/adr/0008-every-integer-is-a-bigint.md) tells why.
- A change event is `{ table, op, key, after? }`, or `{ table, op: 'truncate' }`. `op` is `read`, `insert`, `update`, `delete` or `truncate`. `after` is the full row for `read`, `insert` and `update`. There is no `before`. [ADR 0003](./docs/adr/0003-the-change-event.md) tells why.
- `read` is each row of a table that the position does not have: each row at the first run, and each row of a new table.
- `truncate` tells that the owner dropped a table, or changed the columns of its primary key. Remove all rows of that table from your copy. When the primary key changed, a `read` for each row comes after the `truncate`.
- A change to the other columns of a table, for example a new column, changes the `after` of its rows. Each row then gives an `update`.
- `new Changefeed(databasePath, { position, start })` takes two strategies. Both are required. [ADR 0007](./docs/adr/0007-the-host-gives-the-position-and-the-start.md) tells why.
  - `position` is where the feed keeps what it saw. The feed owns it: the feed disposes it, also when `new Changefeed` throws. A new position is a class that implements `Position`.
    - `new PositionFile(path)` keeps the position in its own SQLite file at that path: one fingerprint for each row of each table. It creates the file when the file is missing. A missing or empty file is a position that no pass saved. A later run goes on from the saved position. Give each feed its own position file.
    - `new PositionInMemory()` keeps the position in memory. It writes nothing to disk. A new feed starts with a new position, so it does not see the changes that the owner made while no feed ran.
  - `start` is what the first pass gives for each table, until a pass saves the position. A new start is a class that implements `Start`.
    - `new ReadEveryRow()` gives each row as `read`.
    - `new Baseline()` keeps the fingerprint of each row, and gives no events. The feed then gives only the changes after the baseline.
  - After the first save, a table that the position does not have gives a `read` for each row, with each start. Thus a table that the owner creates after a baseline gives its rows.
- `watch({ interval, signal })` gives batches. A batch is an array of change events. The feed makes a first pass at once. Then it polls the data version each `interval` milliseconds, and makes a pass only when the data version changed. A pass that finds no change gives no batch, and the feed saves its position at once: for example, the key columns of a new table with no rows.
- A durable feed saves the position of a batch when the loop asks for the next batch. It writes the position in one transaction. Apply each event of a batch before the loop goes on.
- Delivery of a durable feed is at least once. If the process stops before the loop asks for the next batch, the next run gives the same batch again. A loop that stops with `break`, an error or an abort also gives its last batch again at the next run. Apply each event so that a second apply has no effect: a `put` by key, a `remove` by key, a `clear` by table.
- An abort of `signal` stops the poll, and the loop rejects with `signal.reason`.
- A pass holds its read transaction only while it reads. It closes the snapshot before it gives the batch. The poll holds no read transaction. [ADR 0005](./docs/adr/0005-one-snapshot-for-each-pass.md) tells why.
- Dispose closes the connections of the feed. Use `using`, or call `[Symbol.dispose]()`.

## Limits

- You see only the net change between two passes. A row that the owner inserts and deletes between two passes gives no event. A row that the owner changes two times gives one `update`.
- Each commit of the owner makes a pass that reads each table in full. The cost of a pass grows with the size of the database, also when the commit changed one row. [ADR 0001](./docs/adr/0001-capture-by-snapshot-differential.md) names a later option that reads only the changed tables.
- The position keeps one fingerprint for each row of each table. It grows with the number of rows. A `PositionFile` keeps it on disk. A `PositionInMemory` keeps it in memory.
- A feed with a `PositionInMemory` does not see the changes that the owner made while no feed ran.
- A batch holds all the change events of one pass, with the full rows. A first run with `ReadEveryRow`, a new table, or a new primary key of a large table gives a large batch. A `Baseline` keeps no rows, only the fingerprints.
- Precedent for scale: Fivetran's Teleport Sync, which also compares data sets, gives a warning when more than 50,000 records change between two syncs.

## Errors

| Error               | When                                                                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnavailableError`  | SQLite cannot open the database: the file is missing, or the system denies access, a privacy denial too. `new Changefeed` throws it, and a pass throws it. `path` is the path. `cause` is the error of SQLite. |
| `JournalModeError`  | The database is not in WAL mode. `new Changefeed` throws it, and a pass throws it. `path` is the path, and `journalMode` is the mode that `PRAGMA journal_mode` gave, for example `delete`.                    |
| The error of SQLite | All other failures, for example a position file that the feed cannot write.                                                                                                                                    |

## The same concepts in other systems

| System                             | What it does                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CockroachDB `CREATE CHANGEFEED`    | A changefeed for each table that it names. Each message is keyed by the primary key of the row.                                                                                                                                                                                                                                                                                                                     |
| Azure Cosmos DB change feed        | A feed of the changes to the items of a container. A reader goes on from the last position that it read.                                                                                                                                                                                                                                                                                                            |
| Debezium                           | Change data capture from the log of the database. It gives one topic for each table, keyed by the primary key. Its event has the envelope `before`, `after`, `op` (`c`, `u`, `d`, `r`, `t`), `source` and `ts_ms`. This package keeps `op` and `after`. Its `read` is the `r`, and its `truncate` is the `t`. The embedded engine keeps its offsets in a file that the host names (`offset.storage.file.filename`). |
| Kafka `auto.offset.reset`          | It applies when a consumer has no committed offset. `earliest` reads each record again, and `latest` reads only the records that come after the consumer starts. The group, which keeps the committed offsets, is a separate choice. The `position` of the feed is the group, and its `start` is the reset: `ReadEveryRow` is `earliest`, and `Baseline` is `latest`.                                               |
| Debezium `snapshot.mode`           | `initial` reads each row of each table at the first start, and `no_data` reads none. A custom mode is a class of its `Snapshotter` interface. The offsets go to a store that the host selects (`offset.storage`, a file or memory). `ReadEveryRow` is `initial`, `Baseline` is `no_data`, and `Position` is the store.                                                                                              |
| Kafka consumer auto-commit         | A poll commits the offsets of the records that the last poll gave. Delivery is at least once. The feed saves its position in the same way: at the next request for a batch.                                                                                                                                                                                                                                         |
| Kafka Connect JDBC source          | Change data capture by query. Its modes are `bulk`, `incrementing`, `timestamp` and `timestamp+incrementing`. It does not see a hard delete: a deleted row is not in the next query. This package compares the full table, so it sees each delete.                                                                                                                                                                  |
| Fivetran Teleport Sync             | It compares the data set of the source with the data set of the last sync, with no log. It needs only a read-only user and no timestamp columns. This package does the same for a SQLite file.                                                                                                                                                                                                                      |
| Labio and Garcia-Molina, VLDB 1996 | "Efficient Snapshot Differential Algorithms for Data Warehousing". A snapshot differential compares two snapshots of a source and gives inserts, updates and deletes. This package is a snapshot differential.                                                                                                                                                                                                      |
| elt                                | The composition of `DataVersion`, `Snapshot` and `SnapshotDifferential` runs in production for 14 databases of macOS apps. This package moves it into one place.                                                                                                                                                                                                                                                    |

A join, a filter or a projection is not in the feed. The host makes it from the events of the tables, as a consumer of Debezium or of a CockroachDB changefeed does.

## Built on

This package needed four changes in other packages. All four are done:

1. `@zukhruf/snapshot-differential` gives `insert` and `update` in place of one `upsert`.
2. `@zukhruf/async` gives the change watcher `ChangeWatcher`. It reads a gauge, the data version, at each check, and tells when its value changed.
3. `@zukhruf/snapshot-differential` fingerprints bytes (`Uint8Array`, `Buffer`) in a record and in a key. Thus a `BLOB` column can be in `after` and in a key.
4. `@zukhruf/sqlite-open` opens the read-only connection and throws `UnavailableError`. This package exports the same `UnavailableError` class as `@zukhruf/sqlite-snapshot` and `@zukhruf/sqlite-data-version` (repository ADR 0001, rule 6).

## Documentation

- [0001 Capture by snapshot differential](./docs/adr/0001-capture-by-snapshot-differential.md)
- [0002 WAL is required](./docs/adr/0002-wal-is-required.md)
- [0003 The change event](./docs/adr/0003-the-change-event.md)
- [0004 The feed owns its position](./docs/adr/0004-the-feed-owns-its-position.md)
- [0005 One snapshot for each pass](./docs/adr/0005-one-snapshot-for-each-pass.md)
- [0006 Every table, keyed by its primary key](./docs/adr/0006-every-table-keyed-by-its-primary-key.md)
- [0007 The host gives the position and the start](./docs/adr/0007-the-host-gives-the-position-and-the-start.md)
- [0008 Every integer is a bigint](./docs/adr/0008-every-integer-is-a-bigint.md)

## Development

Run the commands from the workspace root.

```sh
npx nx run sqlite-changefeed:test        # builds, then runs the tests
npx nx run sqlite-changefeed:typecheck   # formats, lints, then type checks
```

```
src/
  changefeed.ts           Changefeed: the connections, the runs of watch, and the save of a batch
  pass.ts                 one pass in one snapshot, and the WAL check
  tables.ts               the tables of PRAGMA table_list, the key of each table, and its rows
  table-changes.ts        the change events of one table, and its snapshot with no events
  position.ts             Position, and what a pass changes in it
  position-file.ts        PositionFile: the position in its own SQLite file
  position-in-memory.ts   PositionInMemory: the position in memory
  start.ts                Start: what the first pass gives for a table
  read-every-row.ts       ReadEveryRow: a read for each row
  baseline.ts             Baseline: fingerprints, and no events
  change-event.ts         the change event
  journal-mode-error.ts   JournalModeError
  index.ts                the public exports
  changefeed.test.ts      the tests
```
