import type { SnapshotState } from '@zukhruf/snapshot-differential';

/**
 * What the feed saw of one table: its key columns, and the snapshot of the
 * differential, one fingerprint for each key.
 */
export type TablePosition = {
  readonly keyColumns: readonly string[];
  readonly state: SnapshotState;
};

/**
 * What a pass changes in the position: the tables it saw differently, and the
 * tables the owner dropped.
 */
export type PositionUpdate = {
  readonly tables: ReadonlyMap<string, TablePosition>;
  readonly dropped: readonly string[];
};

/**
 * Where the feed keeps what it saw at its last saved batch. The feed owns the
 * position that it gets, and disposes it. A new position is a class that
 * implements this interface.
 */
export interface Position extends Disposable {
  /** Whether a pass saved this position before. The start applies until one did. */
  started(): boolean;
  /** The key columns of each table that the position has. */
  keyColumns(): ReadonlyMap<string, readonly string[]>;
  /** The snapshot of one table that the position has, for the differential. */
  state(table: string): SnapshotState;
  /** Keeps the update of one batch, all of it or none of it. */
  save(update: PositionUpdate): void;
}
