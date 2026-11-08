import {
  ClosedWorld,
  SnapshotDifferential,
  type SnapshotState,
} from '@zukhruf/snapshot-differential';

import type { ChangeEvent } from './change-event.ts';
import { changedColumns, columnHashes } from './column-hashes.ts';
import type { TablePosition } from './position.ts';
import type { KeyedRow, Table } from './tables.ts';

/** The change events of one table in a pass, and its new snapshot. */
export type TableChanges = {
  readonly events: ChangeEvent[];
  readonly state: SnapshotState;
};

// The change events of one table against what the position saved of it, and
// its new snapshot. null: the position does not have the table, so each row
// is a read.
export async function tableChanges(
  table: Table,
  saved: TablePosition | null,
): Promise<TableChanges> {
  const events: ChangeEvent[] = [];
  for await (const change of differentialOf(table).diff(
    table.rows(),
    saved?.state ?? null,
  )) {
    switch (change.type) {
      case 'insert':
        events.push({
          table: table.name,
          op: saved === null ? 'read' : 'insert',
          key: change.record.key,
          after: change.record.after,
        });
        break;
      case 'update':
        // The differential gives an update only for a key of the saved
        // snapshot.
        if (saved === null)
          throw new TypeError(`${table.name} gave an update with no snapshot`);
        events.push({
          table: table.name,
          op: 'update',
          key: change.record.key,
          after: change.record.after,
          changed: changedColumns(
            { hashes: change.savedFingerprint, columns: saved.columns },
            {
              hashes: columnHashes(change.record.after, table.columns),
              columns: table.columns,
            },
          ),
        });
        break;
      case 'delete':
        events.push({ table: table.name, op: 'delete', key: change.key });
        break;
      case 'state':
        return { events, state: change.state };
    }
  }
  throw new TypeError(`The differential of ${table.name} gave no snapshot`);
}

// The snapshot of one table with no events: it keeps no row, only the
// fingerprint of each.
export async function snapshotOf(table: Table): Promise<SnapshotState> {
  for await (const change of differentialOf(table).diff(table.rows(), null))
    if (change.type === 'state') return change.state;
  throw new TypeError(`The differential of ${table.name} gave no snapshot`);
}

function differentialOf(table: Table): SnapshotDifferential<KeyedRow> {
  return new SnapshotDifferential<KeyedRow>({
    name: table.name,
    primaryKey: table.keyColumns,
    key: (row) => table.keyColumns.map((column) => keyValueOf(row, column)),
    fingerprint: (row) => columnHashes(row.after, table.columns),
    // A pass reads each row of the table, so a key it does not find was
    // deleted.
    policy: new ClosedWorld(),
  });
}

function keyValueOf(row: KeyedRow, column: string) {
  const value = row.key[column];
  if (value === undefined)
    throw new TypeError(`A row has no value for the key column ${column}`);
  return value;
}
