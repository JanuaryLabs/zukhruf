import type { MapState } from '@zukhruf/checkpoint';
import type { SnapshotState } from '@zukhruf/snapshot-differential';
import { Snapshot } from '@zukhruf/sqlite-snapshot';

import type { ChangeEvent } from './change-event.ts';
import type { Claim } from './claim.ts';
import { JournalModeError } from './journal-mode-error.ts';
import type { Start } from './start.ts';
import { tableChanges } from './table-changes.ts';
import { tablesOf } from './tables.ts';
import { touchedTables } from './touched-tables.ts';
import { walFrames } from './wal-frames.ts';

// A pass reads the tables in one snapshot, and compares them with what the
// claim saw. It holds the snapshot only while it reads. Until a checkpoint or
// a pass of this watch saw the owner, the start gives what each table gives.
// After that, when the owner's WAL still holds every frame since the last
// pass, a pass reads only the tables that those frames wrote; else it reads
// each table. The frames are read before the snapshot, so a commit after them
// is in the snapshot or in the frames of the next pass. The map states change
// only after every table is read, so a pass that fails changes none.
export async function pass<W>(
  path: string,
  claim: Claim<W>,
  start: Start,
): Promise<ChangeEvent[]> {
  const seen = claim.seen();
  const frames = walFrames(path, seen === undefined ? null : seen.wal);
  using snapshot = new Snapshot(path);
  requireWal(snapshot);
  const touched =
    frames.changed === null
      ? null
      : touchedTables(path, snapshot, frames.changed, frames.progress.salt);
  const known = new Map(await Array.fromAsync(claim.tables.entries()));
  const events: ChangeEvent[] = [];
  const writes: (() => void)[] = [];
  const current = tablesOf(snapshot);
  for (const table of current) {
    const shape = known.get(table.name);
    // No frame wrote the table, and its shape is the one the claim saw.
    if (touched !== null && shape !== undefined && !touched.has(table.name))
      continue;
    const same =
      shape !== undefined &&
      JSON.stringify(shape.keyColumns) === JSON.stringify(table.keyColumns);
    if (shape !== undefined && !same)
      events.push({ table: table.name, op: 'truncate' });
    const fingerprints = claim.fingerprints(table.name);
    const saved = same
      ? { columns: shape.columns, state: await stateOf(fingerprints) }
      : null;
    const changes =
      seen === undefined
        ? await start.table(table)
        : await tableChanges(table, saved);
    // One push for each event: a spread of a large table's events into one
    // call overflows the stack.
    for (const event of changes.events) events.push(event);
    // A table with other columns is kept also when it has no row, so the
    // next update compares its hashes with the right columns.
    const sameColumns =
      saved !== null &&
      JSON.stringify(saved.columns) === JSON.stringify(table.columns);
    if (!same || !sameColumns)
      writes.push(() =>
        claim.tables.set(table.name, {
          keyColumns: table.keyColumns,
          columns: table.columns,
        }),
      );
    writes.push(() => {
      // The fingerprints of other key columns are of other keys.
      if (shape !== undefined && !same) fingerprints.clear();
      keepChanged(
        fingerprints,
        saved === null ? {} : saved.state.snapshot,
        changes.state,
      );
    });
  }
  const names = new Set(current.map((table) => table.name));
  for (const table of known.keys()) {
    if (names.has(table)) continue;
    events.push({ table, op: 'truncate' });
    writes.push(() => {
      claim.tables.delete(table);
      claim.fingerprints(table).clear();
    });
  }
  for (const write of writes) write();
  claim.give({ wal: frames.progress });
  return events;
}

// The kept fingerprints of one table, in memory, as the differential
// compares them.
async function stateOf(fingerprints: MapState<string>): Promise<SnapshotState> {
  return {
    snapshot: Object.fromEntries(await Array.fromAsync(fingerprints.entries())),
  };
}

// Sets the fingerprint of each new or changed key, and deletes each key that
// is gone, so a commit writes only the rows that changed.
function keepChanged(
  fingerprints: MapState<string>,
  before: SnapshotState['snapshot'],
  after: SnapshotState,
): void {
  for (const [key, entry] of Object.entries(after.snapshot)) {
    const fingerprint = fingerprintOf(entry);
    if (before[key] !== fingerprint) fingerprints.set(key, fingerprint);
  }
  for (const key of Object.keys(before))
    if (!Object.hasOwn(after.snapshot, key)) fingerprints.delete(key);
}

// The feed gives the differential no expiresBy, so each entry is a
// fingerprint alone.
function fingerprintOf(entry: SnapshotState['snapshot'][string]): string {
  if (typeof entry !== 'string')
    throw new TypeError('The feed keeps no expiry');
  return entry;
}

// The owner can replace the file, and the new file can have another mode.
export function requireWal(snapshot: Snapshot): void {
  const [row] = snapshot.all('PRAGMA journal_mode');
  if (row === undefined) throw new TypeError('PRAGMA journal_mode gave no row');
  const mode = String(row.journal_mode);
  if (mode !== 'wal') throw new JournalModeError(snapshot.path, mode);
}
