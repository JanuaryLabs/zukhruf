import {
  ClosedWorld,
  SnapshotDifferential,
  type SnapshotState,
} from '@zukhruf/snapshot-differential';

import type { ChangeEvent } from './change-event.ts';
import type { KeyedRow, Table } from './tables.ts';

/** The change events of one table in a pass, and its new snapshot. */
export type TableChanges = {
  readonly events: ChangeEvent[];
  readonly state: SnapshotState;
};

// The change events of one table against its snapshot in the position, and
// its new snapshot. null as the snapshot: the position does not have the
// table, so each row is a read.
export async function tableChanges(
  table: Table,
  saved: SnapshotState | null,
): Promise<TableChanges> {
  const events: ChangeEvent[] = [];
  for await (const change of differentialOf(table).diff(table.rows(), saved)) {
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
        events.push({
          table: table.name,
          op: 'update',
          key: change.record.key,
          after: change.record.after,
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
