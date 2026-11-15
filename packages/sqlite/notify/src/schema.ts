import { Declaration } from '@zukhruf/sqlite-drift';

// The tables of the notification queue, the listeners and their channels. The
// constructor makes a file store them as declared, and keeps the rows of each
// table that a later release rebuilds (README, "The tables").
export const notifySchema = new Declaration(
  [
    // AUTOINCREMENT: a plain INTEGER PRIMARY KEY gives the ids of trimmed rows
    // again, and a listener whose last id is higher never reads the new rows
    // (research 20b T2).
    `CREATE TABLE zukhruf_notify_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    payload TEXT NOT NULL,
    process_id INTEGER NOT NULL
  ) STRICT`,
    `CREATE TABLE zukhruf_notify_listener (
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL UNIQUE,
    position INTEGER NOT NULL,
    process_id INTEGER NOT NULL
  ) STRICT`,
    `CREATE INDEX zukhruf_notify_listener_position ON zukhruf_notify_listener (position)`,
    // No foreign key: a caller's connection can have foreign_keys off, so the
    // package removes the channel rows of a listener with its listener row.
    `CREATE TABLE zukhruf_notify_channel (
    channel TEXT NOT NULL,
    listener TEXT NOT NULL,
    PRIMARY KEY (channel, listener)
  ) STRICT, WITHOUT ROWID`,
    // One row: the release of this package that last applied the declaration
    // (docs/adr/0009). Not PRAGMA user_version: a file has one, and the tables
    // of another package can share the file.
    `CREATE TABLE zukhruf_notify_version (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version TEXT NOT NULL
  ) STRICT`,
  ],
  { rows: 'keep' },
);

// The highest id ever given. It is the seq of sqlite_sequence, so it stays
// right when the trim removed every row.
export const HIGHEST_ID = `coalesce((SELECT seq FROM sqlite_sequence WHERE name = 'zukhruf_notify_queue'), 0)`;
