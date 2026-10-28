# The change event

A pass finds the rows of each table that changed. The host applies each change to its own copy. The host must know the table, the kind of each change, the key of the row, and the new row.

Debezium gives the common envelope of change data capture: `before`, `after`, `op`, `source` and `ts_ms`. `op` is `c` (create), `u` (update), `d` (delete), `r` (read) or `t` (truncate). `r` is a row of the first snapshot of a table, not a change that occurred. `t` tells that all rows of a table are gone. Debezium and CockroachDB give one feed for each table, keyed by the primary key.

## Decision

A change event is `{ table, op, key, after? }`, or `{ table, op: 'truncate' }`:

- `table` is the name of the table.
- `op` is `read`, `insert`, `update`, `delete` or `truncate`. These are the `r`, `c`, `u`, `d` and `t` of Debezium, as words.
- `key` is an object of the key columns and their values ([ADR 0006](./0006-every-table-keyed-by-its-primary-key.md)).
- `after` is the full row for `read`, `insert` and `update`. A `delete` has no `after`.

A pass gives `read` for each row of a table that the position does not have: each row at the first run, and each row of a new table. Then the host can tell a first load from a row that the owner inserted.

A pass gives `truncate` when the owner dropped a table. It also gives `truncate` when the columns of the primary key of a table changed, and then a `read` for each row of the table. The rows in the copy of the host have keys of the old columns. The host removes them all, and the `read` events load the rows with the new keys.

A change to the other columns of a table changes the `after` of each row. Each row then gives an `update`.

There is no `before`. The position keeps a fingerprint of each row, not the row ([ADR 0004](./0004-the-feed-owns-its-position.md)). A `before` would need the position to keep each row.

There is no `source` and no `ts_ms`. SQLite gives no time of a commit and no position of a log to a reader. The host knows its own path and its own clock.

## Package change

`@zukhruf/snapshot-differential` gives one `upsert` for a new or a changed record. It must give `insert` and `update` in its place. The diff already compares each key with the last snapshot (`src/snapshot-differential.ts`, line 107): a key that the last snapshot does not have is an insert, and a key with a different fingerprint is an update. The snapshot differential of Labio and Garcia-Molina gives inserts, updates and deletes too. Thus the change passes the zero-consumer test: the differential needs it with no host.

The feed changes `insert` into `read` for a table that the position does not have. `read` and `truncate` are concepts of change data capture, not of the differential.

## Considered Options

- **The envelope of Debezium, with `before`.** The position then keeps each row, and it grows with the data of the owner, not only with the number of rows.
- **`upsert` and `delete` only.** The host cannot tell a new row from a changed row, and it cannot tell a first load from new rows.
- **No `read`: a first pass gives `insert`.** A host that counts inserts, or sends a message for each new row, then sees each existing row as new.
- **No event for a dropped table or a new primary key.** The rows of the old table stay in the copy of the host, and no later event removes them.
- **A `delete` for each old key.** The old key columns can be absent from the new primary key, so the host cannot match the old keys with the new rows.
- **`{ table, op, key, after? }` with `read`, `insert`, `update` and `delete`, and `{ table, op: 'truncate' }`.** This option was selected.

## Consequences

- An `update` gives the full new row. The host does not know which columns changed.
- A `delete` gives only the key.
- A new column gives an `update` for each row of its table.
- A `truncate` has no `key` and no `after`. A host that handles events by key must handle `truncate` first.
