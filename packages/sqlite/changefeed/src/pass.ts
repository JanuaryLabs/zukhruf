import { Snapshot } from '@zukhruf/sqlite-snapshot';

import type { ChangeEvent } from './change-event.ts';
import { JournalModeError } from './journal-mode-error.ts';
import type { Position, PositionUpdate, TablePosition } from './position.ts';
import type { Start } from './start.ts';
import { tableChanges } from './table-changes.ts';
import { tablesOf } from './tables.ts';
import { touchedTables } from './touched-tables.ts';
import { walFrames } from './wal-frames.ts';

// A pass reads the tables in one snapshot, and compares them with the
// position. It holds the snapshot only while it reads. Until the position is
// saved once, the start gives what each table gives. After that, when the
// owner's WAL still holds every frame since the last pass, a pass reads only
// the tables that those frames wrote; else it reads each table. The frames
// are read before the snapshot, so a commit after them is in the snapshot or
// in the frames of the next pass.
export async function pass(
  path: string,
  position: Position,
  start: Start,
): Promise<{ events: ChangeEvent[]; update: PositionUpdate }> {
  const first = !position.started();
  const frames = walFrames(path, first ? null : position.wal());
  using snapshot = new Snapshot(path);
  requireWal(snapshot);
  const touched =
    frames.changed === null
      ? null
      : touchedTables(path, snapshot, frames.changed, frames.progress.salt);
  const known = position.keyColumns();
  const events: ChangeEvent[] = [];
  const tables = new Map<string, TablePosition>();
  const current = tablesOf(snapshot);
  for (const table of current) {
    const keyColumns = known.get(table.name);
    // No frame wrote the table, and its shape is the one the position has.
    if (
      touched !== null &&
      keyColumns !== undefined &&
      !touched.has(table.name)
    )
      continue;
    const same =
      keyColumns !== undefined &&
      JSON.stringify(keyColumns) === JSON.stringify(table.keyColumns);
    if (keyColumns !== undefined && !same)
      events.push({ table: table.name, op: 'truncate' });
    const saved = same ? position.table(table.name) : null;
    const changes = first
      ? await start.table(table)
      : await tableChanges(table, saved);
    // One push for each event: a spread of a large table's events into one
    // call overflows the stack.
    for (const event of changes.events) events.push(event);
    // A table with other columns is saved also when it has no row, so the
    // next update compares its hashes with the right columns.
    const sameColumns =
      saved !== null &&
      JSON.stringify(saved.columns) === JSON.stringify(table.columns);
    if (!same || !sameColumns || changes.events.length > 0)
      tables.set(table.name, {
        keyColumns: table.keyColumns,
        columns: table.columns,
        state: changes.state,
      });
  }
  const names = new Set(current.map((table) => table.name));
  const dropped = [...known.keys()].filter((table) => !names.has(table));
  for (const table of dropped) events.push({ table, op: 'truncate' });
  return { events, update: { tables, dropped, wal: frames.progress } };
}

// The owner can replace the file, and the new file can have another mode.
export function requireWal(snapshot: Snapshot): void {
  const [row] = snapshot.all('PRAGMA journal_mode');
  if (row === undefined) throw new TypeError('PRAGMA journal_mode gave no row');
  const mode = String(row.journal_mode);
  if (mode !== 'wal') throw new JournalModeError(snapshot.path, mode);
}
