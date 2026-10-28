import type { SQLOutputValue } from 'node:sqlite';

import type { KeyValue } from '@zukhruf/snapshot-differential';
import type { Snapshot } from '@zukhruf/sqlite-snapshot';

import type { Key, Row } from './change-event.ts';

// A row with its key, as the differential compares it.
export type KeyedRow = { readonly key: Key; readonly after: Row };

// A table of the feed, and the columns of the identity that SQLite makes
// unique and not NULL.
export type Table = {
  readonly name: string;
  readonly keyColumns: readonly string[];
  rows(): Iterable<KeyedRow>;
};

// Each entry of PRAGMA table_list with type table, except the internal
// tables of SQLite. Views, virtual tables and shadow tables have no rows of
// their own in the file.
export function tablesOf(snapshot: Snapshot): Table[] {
  return snapshot
    .all(
      `SELECT name FROM pragma_table_list
       WHERE schema = 'main' AND type = 'table'
         AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
       ORDER BY name`,
    )
    .map(({ name }) => {
      const table = text(name);
      const primaryKey = identifyingPrimaryKey(snapshot, table);
      const from = `FROM "${table.replaceAll('"', '""')}"`;
      if (primaryKey === null)
        return {
          name: table,
          keyColumns: ['rowid'],
          rows: () =>
            snapshot
              .iterate(`SELECT rowid AS rowid, * ${from}`)
              .map(({ rowid, ...after }) => ({
                key: { rowid: keyValue(rowid) },
                after,
              })),
        };
      return {
        name: table,
        keyColumns: primaryKey,
        rows: () =>
          snapshot.iterate(`SELECT * ${from}`).map((row) => {
            const after = { ...row };
            return {
              key: Object.fromEntries(
                primaryKey.map((column) => [column, keyValue(after[column])]),
              ),
              after,
            };
          }),
      };
    });
}

// The columns of the declared primary key when SQLite makes it unique and
// not NULL: as an INTEGER PRIMARY KEY, or when each of its columns is NOT
// NULL. PRAGMA table_info gives NOT NULL for each primary key column of a
// WITHOUT ROWID table, because SQLite enforces it there. null when the rowid identifies the row: a table
// with no primary key, or one whose declared primary key can hold NULL in
// many rows.
function identifyingPrimaryKey(
  snapshot: Snapshot,
  table: string,
): readonly string[] | null {
  const columns = snapshot.all(
    'SELECT name, type, "notnull" FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk',
    table,
  );
  const [first, ...others] = columns;
  if (first === undefined) return null;
  const integerPrimaryKey =
    others.length === 0 && text(first.type).toUpperCase() === 'INTEGER';
  if (integerPrimaryKey || columns.every((column) => column.notnull === 1))
    return columns.map((column) => text(column.name));
  return null;
}

function text(value: SQLOutputValue | undefined): string {
  if (typeof value !== 'string')
    throw new TypeError(`SQLite gave ${String(value)} for a name`);
  return value;
}

// The schema rules above keep NULL out of a key, and node:sqlite gives a
// bigint only to a statement that asks for it.
function keyValue(value: SQLOutputValue | undefined): KeyValue {
  if (value === null || value === undefined || typeof value === 'bigint')
    throw new TypeError(`SQLite gave ${String(value)} for a key value`);
  return value;
}
