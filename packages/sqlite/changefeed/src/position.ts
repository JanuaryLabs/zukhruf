import type { SnapshotState } from '@zukhruf/snapshot-differential';

import type { Batch } from './batch.ts';
import type { ChangeEvent } from './change-event.ts';
import type { WalProgress } from './wal-frames.ts';

/**
 * What the feed saw of one table: its key columns, and the snapshot of the
 * differential, one fingerprint for each key.
 */
export type TablePosition = {
  readonly keyColumns: readonly string[];
  /** The columns that the fingerprints hash, in their order. */
  readonly columns: readonly string[];
  readonly state: SnapshotState;
};

/**
 * What a pass changes in the position: the tables it saw differently, and the
 * tables the owner dropped.
 */
export type PositionUpdate = {
  readonly tables: ReadonlyMap<string, TablePosition>;
  readonly dropped: readonly string[];
  /** How far the pass read the owner's WAL; null when it had no WAL. */
  readonly wal: WalProgress | null;
};

/**
 * Where the feed keeps what it saw at its last saved batch. The feed owns the
 * position that it gets, and disposes it. A new position is a class that
 * implements this interface.
 */
export interface Position<B extends Batch = Batch> extends Disposable {
  /** The batch of the events of the next save: the position knows its kind. */
  batch(events: readonly ChangeEvent[]): B;
  /** Whether a pass saved this position before. The start applies until one did. */
  started(): boolean;
  /** The key columns of each table that the position has. */
  keyColumns(): ReadonlyMap<string, readonly string[]>;
  /** How far the last saved pass read the owner's WAL. */
  wal(): WalProgress | null;
  /** What the position has of one table: its columns and its snapshot. */
  table(table: string): TablePosition;
  /** Keeps the update of one batch, all of it or none of it. */
  save(update: PositionUpdate): void;
}
