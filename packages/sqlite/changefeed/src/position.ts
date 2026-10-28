import type { SnapshotState } from '@zukhruf/snapshot-differential';

// What the feed saw of one table: its key columns, and the snapshot of the
// differential, one fingerprint for each key.
export type TablePosition = {
  readonly keyColumns: readonly string[];
  readonly state: SnapshotState;
};

// What a pass changes in the position: the tables it saw differently, and
// the tables the owner dropped.
export type PositionUpdate = {
  readonly tables: ReadonlyMap<string, TablePosition>;
  readonly dropped: readonly string[];
};

// What the feed saw at its last saved batch.
export interface Position {
  // The key columns of each table that the position has.
  keyColumns(): ReadonlyMap<string, readonly string[]>;
  // The snapshot of one table that the position has, for the differential.
  state(table: string): SnapshotState;
  save(update: PositionUpdate): void;
}
