import { Snapshot } from '@zukhruf/sqlite-snapshot';

import type { ChangeEvent } from './change-event.ts';
import { JournalModeError } from './journal-mode-error.ts';
import type { Position, PositionUpdate, TablePosition } from './position.ts';
import { tableChanges } from './table-changes.ts';
import { tablesOf } from './tables.ts';

// A pass reads each table in one snapshot, and compares it with the
// position. It holds the snapshot only while it reads.
export async function pass(
  path: string,
  position: Position,
): Promise<{ events: ChangeEvent[]; update: PositionUpdate }> {
  using snapshot = new Snapshot(path);
  requireWal(snapshot);
  const known = position.keyColumns();
  const events: ChangeEvent[] = [];
  const tables = new Map<string, TablePosition>();
  const current = tablesOf(snapshot);
  for (const table of current) {
    const keyColumns = known.get(table.name);
    const same =
      keyColumns !== undefined &&
      JSON.stringify(keyColumns) === JSON.stringify(table.keyColumns);
    if (keyColumns !== undefined && !same)
      events.push({ table: table.name, op: 'truncate' });
    const changes = await tableChanges(
      table,
      same ? position.state(table.name) : null,
    );
    events.push(...changes.events);
    if (!same || changes.events.length > 0)
      tables.set(table.name, {
        keyColumns: table.keyColumns,
        state: changes.state,
      });
  }
  const names = new Set(current.map((table) => table.name));
  const dropped = [...known.keys()].filter((table) => !names.has(table));
  for (const table of dropped) events.push({ table, op: 'truncate' });
  return { events, update: { tables, dropped } };
}

// The owner can replace the file, and the new file can have another mode.
export function requireWal(snapshot: Snapshot): void {
  const [row] = snapshot.all('PRAGMA journal_mode');
  if (row === undefined) throw new TypeError('PRAGMA journal_mode gave no row');
  const mode = String(row.journal_mode);
  if (mode !== 'wal') throw new JournalModeError(snapshot.path, mode);
}
