# @zukhruf/sqlite-changefeed

Some programs keep their data in a SQLite database, and write it while they run. The owner gives no change log and no API. Another program wants each change to the rows, so that it can copy them into a different store. This package gives a changefeed of the database: a change event for each changed row of each table, by the primary key of the row. It reads the database read-only, and it never writes to the file of the owner. It is change data capture by query, also known as a snapshot differential (Labio and Garcia-Molina, VLDB 1996).

The feed composes five packages:

- `@zukhruf/sqlite-data-version` tells when to read again. Its `DataVersion` changes when the owner commits, and it follows a replaced file.
- `@zukhruf/sqlite-snapshot` holds one moment for each pass. All tables of a pass come from the same moment.
- `@zukhruf/snapshot-differential` tells what changed since the last pass.
- The change watcher of `@zukhruf/async` polls the data version, and starts a pass only when it changes.
- `@zukhruf/checkpoint` keeps what the feed saw, in a consumer group of the host. The host commits it ([ADR 0012](./docs/adr/0012-the-feed-keeps-its-position-in-a-consumer-group-of-zukhruf-checkpoint-and-the-host-commits.md)).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment. It uses only `node:sqlite`.

```sh
npm install @zukhruf/sqlite-changefeed
```

In this example, the owner keeps notes in its database, in WAL mode. The reader copies each table into its own store, and commits after each batch:

```ts
import { DatabaseSync } from 'node:sqlite';

import { ConsumerGroup } from '@zukhruf/checkpoint';
import { SqliteCheckpointStore } from '@zukhruf/checkpoint/sqlite';
import { Changefeed, ReadEveryRow } from '@zukhruf/sqlite-changefeed';

using copy = new DatabaseSync(`${process.env.HOME}/.notes-copy/copy.sqlite`);
using feed = new Changefeed(
  `${process.env.HOME}/Library/Application Support/Notes/notes.sqlite`,
  {
    checkpoints: new ConsumerGroup(
      'notes-copy',
      new SqliteCheckpointStore({ database: copy }),
    ),
    stream: 'notes',
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
  await feed.commit();
}
```

The feed gets three things. The consumer group and the stream tell where the feed keeps what it saw: a checkpoint of `@zukhruf/checkpoint`, in a store that the host owns. The start tells what the first pass gives. This is a durable feed: its store is a SQLite database, and a new run goes on from the last commit. Its start is `ReadEveryRow`, so the first run gives each row as a read event.

When the copy is in the database of the store, commit it with the checkpoint. `write` runs in the transaction of the commit, so the rows and the checkpoint commit together, or neither does:

```ts
await feed.commit({ write: (database) => insertRows(database, batch) });
```

A host that sends a message for each change does not want the rows that were there before it started. Give it the start `Baseline`. The first pass is then a baseline: it keeps the fingerprints, and gives an empty batch. Once that batch is committed, a new run gives the changes that the owner made while the feed was stopped:

```ts
using feed = new Changefeed(
  `${process.env.HOME}/Library/Application Support/Notes/notes.sqlite`,
  {
    checkpoints: new ConsumerGroup(
      'notes-alerts',
      new SqliteCheckpointStore({ database: alerts }),
    ),
    stream: 'notes',
    start: new Baseline(),
  },
);

for await (const batch of feed.watch({
  interval: 1_000,
  signal: stop.signal,
  clock: globalThis,
})) {
  for (const event of batch) console.log(event.table, event.op, event.key);
  await feed.commit();
}
```

With `ReadEveryRow`, the first run gives a `read` event for each row of each table. Each later batch gives only the rows that changed. Each integer is a `bigint`:

```
{ table: 'notes',  op: 'read',   key: { id: 1n }, after: { id: 1n, folder_id: 7n, title: 'Plan', body: '…' } }
{ table: 'tags',   op: 'read',   key: { rowid: 3n }, after: { note_id: 1n, tag: 'q4' } }
…
{ table: 'notes',  op: 'update', key: { id: 1n }, after: { id: 1n, folder_id: 7n, title: 'Plan v2', body: '…' }, changed: ['title'] }
{ table: 'tags',   op: 'delete', key: { rowid: 3n } }
{ table: 'drafts', op: 'truncate' }
```

The table `tags` has no primary key, so its key is the `rowid`. The owner dropped the table `drafts`, so the feed gives a `truncate` for it.

## The rules

- The database must be in WAL mode. `new Changefeed(databasePath, { checkpoints, stream, start })` reads `PRAGMA journal_mode`, and throws `JournalModeError` for each other mode. Each pass reads it again, because the owner can replace the file. [ADR 0002](./docs/adr/0002-wal-is-required.md) tells why.
- The feed reads each table that `PRAGMA table_list` gives with type `table`, except a name that starts with `sqlite_`. It does not read an internal table of SQLite (`sqlite_schema`, `sqlite_sequence`, `sqlite_stat*`), a `view`, a `virtual` table, or a `shadow` table. A shadow table holds the data of a virtual table, for example the `notes_fts_data` of an FTS5 table. It is internal to the module of the virtual table. [ADR 0006](./docs/adr/0006-every-table-keyed-by-its-primary-key.md) tells why.
- The key of a row is the identity that SQLite makes unique and not `NULL`. The feed finds it from the schema of each table:
  - A `WITHOUT ROWID` table: its declared primary key. SQLite makes each column of it `NOT NULL`, and `PRAGMA table_info` gives `notnull` 1 for each column of it.
  - A rowid table with an `INTEGER PRIMARY KEY` that is an alias of the `rowid`, or with a primary key whose columns are all declared `NOT NULL`: that primary key. `id INTEGER PRIMARY KEY DESC` in a column definition is not an alias of the `rowid`, and can hold `NULL`.
  - Each other rowid table: the key `{ rowid }`. A declared primary key of a rowid table can hold `NULL` in many rows, so it does not identify a row.
  - The columns of a primary key are the columns of `PRAGMA table_info` with a `pk` above 0, in the order of `pk`.
- `VACUUM` can change the `rowid` of each row of a table with no primary key. The feed compares the rows by `rowid`, so it then gives an event for each `rowid` whose row changed: an `insert` for a new `rowid`, an `update` for a `rowid` that now holds a different row, and a `delete` for a `rowid` that is gone. The SQLite documentation advises an `INTEGER PRIMARY KEY` for a stable `rowid`.
- A pass copies each row into a plain object, because `node:sqlite` gives rows with no prototype. `after` keeps the values that SQLite gives: a `bigint` for an `INTEGER`, a number for a `REAL`, a string, `null`, or a `Uint8Array` for a `BLOB`. A key value is a `bigint` for an `INTEGER` too, such as each `rowid`. [ADR 0008](./docs/adr/0008-every-integer-is-a-bigint.md) tells why.
- A change event is `{ table, op, key, after? }`, or `{ table, op: 'truncate' }`. `op` is `read`, `insert`, `update`, `delete` or `truncate`. `after` is the full row for `read`, `insert` and `update`. There is no `before`. [ADR 0003](./docs/adr/0003-the-change-event.md) tells why.
- An `update` also has `changed`: the columns whose values changed, never empty. The checkpoint keeps one 8-byte hash for each column of each row, so the feed can name them with no copy of the row. A new column, or a dropped one, is the change of each row of its table. Thus a host can tell a change of a state column, such as `is_read`, from a change of the content. [ADR 0009](./docs/adr/0009-an-update-names-its-changed-columns.md) tells why.
- `read` is each row of a table that the checkpoint does not have: each row at the first run, and each row of a new table.
- `truncate` tells that the owner dropped a table, or changed the columns of its primary key. Remove all rows of that table from your copy. When the primary key changed, a `read` for each row comes after the `truncate`.
- A change to the other columns of a table, for example a new column, changes the `after` of its rows. Each row then gives an `update`.
- `new Changefeed(databasePath, { checkpoints, stream, start })` takes where the feed keeps what it saw, and what the first pass gives. All three are required. [ADR 0012](./docs/adr/0012-the-feed-keeps-its-position-in-a-consumer-group-of-zukhruf-checkpoint-and-the-host-commits.md) tells why.
  - `checkpoints` is a `ConsumerGroup` of `@zukhruf/checkpoint`. The host owns its store: the feed never closes it. A `SqliteCheckpointStore`, a `PostgresCheckpointStore` or a `SqlServerCheckpointStore` keeps the checkpoint across runs. A `MemoryCheckpointStore` keeps it in memory, so a new run of the process does not see the changes that the owner made while no feed ran.
  - `stream` names the owner's database in the group. The feed keeps its checkpoint in partition `'0'` of the stream, because one pass reads every table under one WAL progress. Give each database its own stream.
  - The checkpoint has the WAL progress as its position (format version 1), the key columns and the columns of each table in the map state `tables`, and one fingerprint for each key of each table in the map state `table:<name>`.
  - `start` is what the first pass gives for each table while the partition has no checkpoint. A new start is a class that implements `Start`.
    - `new ReadEveryRow()` gives each row as `read`.
    - `new Baseline()` keeps the fingerprint of each row, and gives no events. The feed then gives only the changes after the baseline.
  - After the first pass, a table that the feed did not see gives a `read` for each row, with each start. Thus a table that the owner creates after a baseline gives its rows.
- `watch({ interval, signal, clock })` claims the partition, and gives a batch for each pass: a `readonly ChangeEvent[]`, an empty one too. The claim fences each older claim of the partition. The feed makes a first pass at once. Then it polls the data version each `interval` milliseconds, and makes a pass only when the data version changed. A feed that is made but not watched claims nothing.
- A pass goes on from the batches that the watch gave, also those that no commit saved yet. A pass that fails changes nothing.
- `commit({ write, signal })` saves every batch that the watch gave so far, all of it or none of it, as Kafka's `commitSync` saves the offsets of the last poll. It writes only the fingerprints that changed. Before the watch gave a batch, it rejects with a `TypeError`.
  - With `write`, the store runs it in the transaction of the commit: the host's output and the checkpoint commit together (exactly once). The type of `write` comes from the store. A `MemoryCheckpointStore` takes no `write`.
  - With no `write`, apply each event first, then commit. Delivery is at least once. If the process stops before the commit, the next run gives the same batches again. A loop that stops with `break`, an error or an abort also gives its uncommitted batches again at the next run. Apply each event so that a second apply has no effect: a `put` by key, a `remove` by key, a `clear` by table.
  - A commit of a feed that a newer claim fenced rejects with `CheckpointFencedError`, and runs no write.
- An abort of `signal` stops the poll, and the loop rejects with `signal.reason`.
- A pass holds its read transaction only while it reads. It closes the snapshot before it gives the batch. The poll holds no read transaction. [ADR 0005](./docs/adr/0005-one-snapshot-for-each-pass.md) tells why.
- Dispose closes the connections of the feed. Use `using`, or call `[Symbol.dispose]()`.

## Limits

- You see only the net change between two passes. A row that the owner inserts and deletes between two passes gives no event. A row that the owner changes two times gives one `update`.
- A pass reads only the tables whose b-tree pages the owner's WAL frames wrote since the last pass, when the WAL still holds all those frames. It finds the table of each page from the interior pages of the b-trees only, which it reads from the file and the WAL. Else it reads each table in full: at the first pass, after a reset of the WAL, when a frame wrote a page of the schema, or when the owner has no WAL. An owner that checkpoints its WAL when it closes its last connection, such as elt's SQLite destination at the end of each pass, leaves no frames, so its passes read each table. [ADR 0011](./docs/adr/0011-a-pass-reads-the-tables-that-the-wal-frames-wrote.md) tells why.
- A full pass reads each table in full. Its cost grows with the size of the database, also when the commit changed one row.
- A pass reads the database with the synchronous API of `node:sqlite`, on the thread that runs `watch()`. The event loop of that thread waits until the pass ends. On a Mac with Node 26.13, a `Baseline` pass over a WhatsApp import of 131 MB stopped the event loop of Context Compiler's Ambient for 6.4 s (context-compiler #3942).
- The checkpoint keeps one 8-byte hash for each column of each row of each table. It grows with the number of rows and columns. A pass reads the fingerprints of each table that it reads into memory.
- A feed with a `MemoryCheckpointStore` does not see the changes that the owner made while no feed ran.
- A batch holds all the change events of one pass, with the full rows. A first run with `ReadEveryRow`, a new table, or a new primary key of a large table gives a large batch. A `Baseline` keeps no rows, only the fingerprints.
- Precedent for scale: Fivetran's Teleport Sync, which also compares data sets, gives a warning when more than 50,000 records change between two syncs.

## Errors

| Error                         | When                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnavailableError`            | SQLite cannot open the database: the file is missing, or the system denies access, a privacy denial too. `new Changefeed` throws it, and a pass throws it. `path` is the path. `cause` is the error of SQLite. It is a `MissingError` when the file or a folder on its path is not there, and a `DeniedError` when the system denies access. The package exports both, and both are an `UnavailableError`. |
| `JournalModeError`            | The database is not in WAL mode. `new Changefeed` throws it, and a pass throws it. `path` is the path, and `journalMode` is the mode that `PRAGMA journal_mode` gave, for example `delete`.                                                                                                                                                                                                                |
| `CheckpointFencedError`       | A commit of a feed whose claim a newer watch of the same consumer group and stream took. The commit wrote nothing, also no output. Stop the feed. The error is the one of `@zukhruf/checkpoint`.                                                                                                                                                                                                           |
| `IncompatibleCheckpointError` | `watch()` found a checkpoint whose position the feed cannot read: another format version or shape. Reset the partition with `group.reset({ stream })`. The error is the one of `@zukhruf/checkpoint`.                                                                                                                                                                                                      |
| The error of SQLite           | All other failures.                                                                                                                                                                                                                                                                                                                                                                                        |

## Who uses it

| Consumer                                    | How                                                                                                                                                                                                                                                                                                                                                          | Record                                   |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Context Compiler's Ambient (`apps/ambient`) | `followWarehouse` makes one feed for each selected import with `start: new Baseline()`, and reads `watch({ interval: 1000, signal, clock: globalThis })`. Its journal takes each `ChangeEvent`. Ambient used the feed from its first commit, so the feed replaced no code. It moves to `checkpoints`, `stream` and `commit()` after the release of ADR 0012. | context-compiler 673c1ae, 1d27435, #6285 |

## The same concepts in other systems

| System                             | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CockroachDB `CREATE CHANGEFEED`    | A changefeed for each table that it names. Each message is keyed by the primary key of the row.                                                                                                                                                                                                                                                                                                                                                                                          |
| Azure Cosmos DB change feed        | A feed of the changes to the items of a container. A reader goes on from the last position that it read.                                                                                                                                                                                                                                                                                                                                                                                 |
| Debezium                           | Change data capture from the log of the database. It gives one topic for each table, keyed by the primary key. Its event has the envelope `before`, `after`, `op` (`c`, `u`, `d`, `r`, `t`), `source` and `ts_ms`. This package keeps `op` and `after`. Its `read` is the `r`, and its `truncate` is the `t`. The embedded engine gives the consumer a `RecordCommitter`, and the consumer marks what it processed (`markProcessed`, `markBatchFinished`). `commit()` is that committer. |
| Kafka `auto.offset.reset`          | It applies when a consumer has no committed offset. `earliest` reads each record again, and `latest` reads only the records that come after the consumer starts. The group, which keeps the committed offsets, is a separate choice. The `checkpoints` of the feed are the group, and its `start` is the reset: `ReadEveryRow` is `earliest`, and `Baseline` is `latest`.                                                                                                                |
| Debezium `snapshot.mode`           | `initial` reads each row of each table at the first start, and `no_data` reads none. A custom mode is a class of its `Snapshotter` interface. The offsets go to a store that the host selects (`offset.storage`, a file or memory). `ReadEveryRow` is `initial`, `Baseline` is `no_data`, and the `CheckpointStore` of the consumer group is the store.                                                                                                                                  |
| Kafka consumer `commitSync`        | It commits the offsets of the records that the last poll gave. A consumer that keeps its offsets outside Kafka writes them in the transaction of its output ("Storing Offsets Outside Kafka"). `commit()` does the same, and `commit({ write })` is the external store.                                                                                                                                                                                                                  |
| Kafka Connect exactly-once sources | KIP-618: a source task writes its records and its offsets in one transaction. `commit({ write })` writes the host's output and the checkpoint in one transaction.                                                                                                                                                                                                                                                                                                                        |
| Kafka Connect JDBC source          | Change data capture by query. Its modes are `bulk`, `incrementing`, `timestamp` and `timestamp+incrementing`. It does not see a hard delete: a deleted row is not in the next query. This package compares the full table, so it sees each delete.                                                                                                                                                                                                                                       |
| Fivetran Teleport Sync             | It compares the data set of the source with the data set of the last sync, with no log. It needs only a read-only user and no timestamp columns. This package does the same for a SQLite file.                                                                                                                                                                                                                                                                                           |
| Labio and Garcia-Molina, VLDB 1996 | "Efficient Snapshot Differential Algorithms for Data Warehousing". A snapshot differential compares two snapshots of a source and gives inserts, updates and deletes. This package is a snapshot differential.                                                                                                                                                                                                                                                                           |
| elt                                | The composition of `DataVersion`, `Snapshot` and `SnapshotDifferential` runs in production for 14 databases of macOS apps. This package moves it into one place.                                                                                                                                                                                                                                                                                                                         |

A join, a filter or a projection is not in the feed. The host makes it from the events of the tables, as a consumer of Debezium or of a CockroachDB changefeed does.

## Built on

This package needed five changes in other packages. All five are done:

1. `@zukhruf/snapshot-differential` gives `insert` and `update` in place of one `upsert`.
2. `@zukhruf/async` gives the change watcher `ChangeWatcher`. It reads a gauge, the data version, at each check, and tells when its value changed.
3. `@zukhruf/snapshot-differential` fingerprints bytes (`Uint8Array`, `Buffer`) in a record and in a key. Thus a `BLOB` column can be in `after` and in a key.
4. `@zukhruf/sqlite-open` opens the read-only connection and throws `UnavailableError`. This package exports the same `UnavailableError` class as `@zukhruf/sqlite-snapshot` and `@zukhruf/sqlite-data-version` (repository ADR 0001, rule 6).
5. `@zukhruf/checkpoint` keeps the position and the map states of a consumer group, commits them with the host's output, and fences an older claim (#6201).

## API

`KeyValue` and `SnapshotState` are the types of `@zukhruf/snapshot-differential`, `WallClock` is the type of `@zukhruf/async`, and `ConsumerGroup` is the class of `@zukhruf/checkpoint`.

```ts
type Key = Readonly<Record<string, KeyValue>>; // the values of the key columns, by column
type Row = Readonly<Record<string, SQLOutputValue>>; // a row as node:sqlite gives it

type ChangeEvent =
  | {
      readonly table: string;
      readonly op: 'read' | 'insert';
      readonly key: Key;
      readonly after: Row;
    }
  | {
      readonly table: string;
      readonly op: 'update';
      readonly key: Key;
      readonly after: Row;
      readonly changed: readonly [string, ...string[]]; // never empty
    }
  | { readonly table: string; readonly op: 'delete'; readonly key: Key }
  | { readonly table: string; readonly op: 'truncate' };

type WatchOptions = {
  readonly interval: number; // milliseconds between two polls of the data version
  readonly signal: AbortSignal; // the loop then rejects with signal.reason
  readonly clock: WallClock; // globalThis in production
};

type ChangefeedOptions<W> = {
  readonly checkpoints: ConsumerGroup<W>; // the host owns its store
  readonly stream: string; // the owner's database: partition '0' of this stream
  readonly start: Start; // while the partition has no checkpoint
};

type CommitOptions<W> = {
  readonly write?: W; // runs in the transaction of the commit
  readonly signal?: AbortSignal;
};

class Changefeed<W> implements Disposable {
  constructor(databasePath: string, options: ChangefeedOptions<W>); // UnavailableError, JournalModeError
  watch(
    options: WatchOptions,
  ): AsyncGenerator<readonly ChangeEvent[], void, undefined>; // claims the partition; a batch for each pass
  commit(options?: CommitOptions<W>): Promise<void>; // every batch given so far; CheckpointFencedError
  [Symbol.dispose](): void; // closes the data version, not the store
}

type KeyedRow = { readonly key: Key; readonly after: Row };

type Table = {
  readonly name: string;
  readonly keyColumns: readonly string[];
  readonly columns: readonly string[]; // the columns of a row's after, in order
  rows(): Iterable<KeyedRow>;
};

type TableChanges = {
  readonly events: ChangeEvent[];
  readonly state: SnapshotState;
};

interface Start {
  table(table: Table): Promise<TableChanges>; // the first pass of one table
}

class ReadEveryRow implements Start {} // a read for each row
class Baseline implements Start {} // fingerprints, and no events

class JournalModeError extends Error {
  constructor(path: string, journalMode: string);
  readonly path: string;
  readonly journalMode: string;
}

// From @zukhruf/sqlite-open:
class UnavailableError extends Error {
  constructor(path: string, cause: unknown);
  readonly path: string;
}
class MissingError extends UnavailableError {}
class DeniedError extends UnavailableError {}
```

## Documentation

- [ADR 0001](./docs/adr/0001-capture-by-snapshot-differential.md): capture by snapshot differential.
- [ADR 0002](./docs/adr/0002-wal-is-required.md): WAL is required.
- [ADR 0003](./docs/adr/0003-the-change-event.md): the change event.
- [ADR 0004](./docs/adr/0004-the-feed-owns-its-position.md): the feed owns its position (superseded by ADR 0012).
- [ADR 0005](./docs/adr/0005-one-snapshot-for-each-pass.md): one snapshot for each pass.
- [ADR 0006](./docs/adr/0006-every-table-keyed-by-its-primary-key.md): every table, keyed by its primary key.
- [ADR 0007](./docs/adr/0007-the-host-gives-the-position-and-the-start.md): the host gives the position and the start (superseded in part by ADR 0012).
- [ADR 0008](./docs/adr/0008-every-integer-is-a-bigint.md): every integer is a bigint.
- [ADR 0009](./docs/adr/0009-an-update-names-its-changed-columns.md): an update names its changed columns.
- [ADR 0010](./docs/adr/0010-a-batch-of-a-durable-position-has-a-sequence.md): a batch of a durable position has a sequence (superseded by ADR 0012).
- [ADR 0011](./docs/adr/0011-a-pass-reads-the-tables-that-the-wal-frames-wrote.md): a pass reads the tables that the WAL frames wrote.
- [ADR 0012](./docs/adr/0012-the-feed-keeps-its-position-in-a-consumer-group-of-zukhruf-checkpoint-and-the-host-commits.md): the feed keeps its position in a consumer group of `@zukhruf/checkpoint`, and the host commits.

## Development

Run the commands from the workspace root.

```sh
npx nx run sqlite-changefeed:test        # builds, then runs the tests
npx nx run sqlite-changefeed:typecheck   # formats, lints, then type checks
```

```
src/
  changefeed.ts           Changefeed: the data version, the claim of each watch, and the commit
  claim.ts                the claimed partition, and the WAL progress of the last batch
  formats.ts              the formats of the position, the tables and the fingerprints
  pass.ts                 one pass in one snapshot, and the WAL check
  wal-frames.ts           the frames of the owner's WAL since the saved progress
  page-owners.ts          the table of each b-tree page, from the interior pages
  touched-tables.ts       the tables that the new frames wrote
  column-hashes.ts        the hash of each column of a row, and the changed columns
  tables.ts               the tables of PRAGMA table_list, the key of each table, and its rows
  table-changes.ts        the change events of one table, and its snapshot with no events
  start.ts                Start: what the first pass gives for a table
  read-every-row.ts       ReadEveryRow: a read for each row
  baseline.ts             Baseline: fingerprints, and no events
  change-event.ts         the change event
  journal-mode-error.ts   JournalModeError
  index.ts                the public exports
  changefeed.test.ts      the tests
```
