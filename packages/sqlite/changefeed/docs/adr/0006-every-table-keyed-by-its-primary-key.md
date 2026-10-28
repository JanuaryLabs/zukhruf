# Every table, keyed by its primary key

A feed must know which rows to read, and which values identify a row. SQLite defines both. `PRAGMA table_list` gives each table with its type (`table`, `view`, `virtual` or `shadow`). `PRAGMA table_info` gives the columns of the primary key of a table in its `pk` column, in order, and a `notnull` of 1 for each column that SQLite keeps not `NULL`.

Debezium and CockroachDB give a feed for each table, keyed by the primary key. A join or a projection is the work of a consumer, after the feed.

## Decision

The feed reads each table of the database:

- A table is an entry of `PRAGMA table_list` with type `table` whose name does not start with `sqlite_`. The names `sqlite_schema`, `sqlite_sequence` and `sqlite_stat*` are internal tables of SQLite.
- A `view` has no rows of its own. A `virtual` table can need a module that `node:sqlite` does not have, and its data can be outside the file.
- A `shadow` table holds the data of a virtual table. A probe on SQLite 3.53.4 showed it: an FTS5 table `notes_fts` gave `notes_fts_config`, `notes_fts_data`, `notes_fts_docsize`, `notes_fts_idx` and `notes_fts_content` with type `shadow`. A shadow table is internal to its module, as a `sqlite_*` table is internal to SQLite. The feed does not read it.

The key of a row is the identity that SQLite makes unique and not `NULL`. The feed finds it from the schema of each table:

- A `WITHOUT ROWID` table: its declared primary key. SQLite makes each column of it `NOT NULL`. A probe on SQLite 3.53.4 showed it: an insert of `NULL` failed with "NOT NULL constraint failed". `PRAGMA table_info` also gives `notnull` 1 for each such column, also with no `NOT NULL` in the declaration. Thus the rule for a primary key whose columns are all `NOT NULL` covers this table, and the feed does not read the `wr` flag of `PRAGMA table_list`.
- A rowid table with an `INTEGER PRIMARY KEY`: that column. It is the `rowid`.
- A rowid table with a primary key whose columns are all declared `NOT NULL`: that primary key.
- Each other rowid table: the key `{ rowid }`. A declared primary key of a rowid table can hold `NULL`, for compatibility with old versions of SQLite. A probe on SQLite 3.53.4 showed it: a table with `code TEXT PRIMARY KEY` accepted two rows with `code` `NULL`. Such a key does not identify a row.
- The columns of a primary key are in the order of `pk`.
- The position keeps the key columns of each table. When they change, the pass gives a `truncate` and then a `read` for each row ([ADR 0003](./0003-the-change-event.md)).
- A key can hold a `BLOB` as a `Uint8Array`. This needs the change to `@zukhruf/snapshot-differential` that fingerprints binary values: its `KeyValue` gains `Uint8Array`.

`VACUUM` can change the `rowid` of the rows of a table with no primary key. A probe on SQLite 3.53.4 showed it: the rowids 2, 4, 5, 6 became 1, 2, 3, 4. The rowids of an `INTEGER PRIMARY KEY` table and of a `TEXT PRIMARY KEY` table did not change. Thus a `VACUUM` of a table with no primary key gives an event for each rowid whose row changed. A test showed it: the rowids 2 and 3 became 1 and 2, and the feed gave an `insert` for rowid 1, an `update` for rowid 2 and a `delete` for rowid 3. The SQLite documentation advises an `INTEGER PRIMARY KEY` for a stable `rowid`.

## Considered Options

- **The host gives queries with a key (streams).** The host must know SQL and the layout of the owner, and a stream is a concept of the host, not of a SQLite database. A join in a query also hides which table changed.
- **The declared primary key always.** A declared primary key of a rowid table can hold `NULL` in many rows. Two such rows then have the same key, and the diff cannot tell them apart.
- **The `rowid` always.** A consumer expects the declared key of a table, as Debezium and CockroachDB give it. The SQLite documentation advises an `INTEGER PRIMARY KEY` as the stable name of a row. A `WITHOUT ROWID` table also has no `rowid`.
- **The identity that SQLite makes unique and not `NULL`: the primary key when SQLite enforces it, else the `rowid`.** This option was selected.

## Consequences

- The host gives no SQL. A new table of the owner gives `read` events with no change to the host.
- The data of the owner never stops a pass: each key is unique and not `NULL`.
- A pass reads each table, also the tables that the host does not need. The host drops their events.
- A virtual table gives no events. A host that needs its data reads it itself.
- A `VACUUM` of a table with no primary key gives many events, and no row changed.
- A join, a filter or a projection is the work of the host, from the events of the tables.
