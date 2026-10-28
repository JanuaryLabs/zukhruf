import {
  ClosedWorld,
  SnapshotDifferential,
  type SnapshotState,
} from '@zukhruf/snapshot-differential';

import type { ChangeEvent } from './change-event.ts';
import type { KeyedRow, Table } from './tables.ts';

// The change events of one table against its snapshot in the position, and
// its new snapshot. null as the snapshot: the position does not have the
// table, so each row is a read.
export async function tableChanges(
  table: Table,
  saved: SnapshotState | null,
): Promise<{ events: ChangeEvent[]; state: SnapshotState }> {
  const differential = new SnapshotDifferential<KeyedRow>({
    name: table.name,
    primaryKey: table.keyColumns,
    key: (row) => table.keyColumns.map((column) => keyValueOf(row, column)),
    // A pass reads each row of the table, so a key it does not find was
    // deleted.
    policy: new ClosedWorld(),
  });
  const events: ChangeEvent[] = [];
  for await (const change of differential.diff(table.rows(), saved)) {
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

function keyValueOf(row: KeyedRow, column: string) {
  const value = row.key[column];
  if (value === undefined)
    throw new TypeError(`A row has no value for the key column ${column}`);
  return value;
}
