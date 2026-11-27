import type { FencingToken } from '@zukhruf/fencing';

import type {
  CheckpointKey,
  CheckpointSummary,
  SignalOption,
  StateChanges,
  StoredCheckpoint,
  StoredValue,
} from './checkpoint.ts';

/**
 * Where checkpoints are kept (ADR 0011). `ConsumerGroup` is the only caller.
 * `W` is the type of the `write` that a commit runs in its transaction.
 */
export interface CheckpointStore<W> {
  /** Raises the epoch of the key in one atomic write, and gives it. */
  claim(key: CheckpointKey, options?: SignalOption): Promise<FencingToken>;
  read(
    key: CheckpointKey,
    options?: SignalOption,
  ): Promise<StoredCheckpoint | undefined>;
  get(
    key: CheckpointKey,
    state: string,
    keys: readonly string[],
    options?: SignalOption,
  ): Promise<ReadonlyMap<string, StoredValue>>;
  scan(
    key: CheckpointKey,
    state: string,
    options?: SignalOption,
  ): AsyncIterable<readonly [string, StoredValue]>;
  /**
   * In one transaction: checks that the stored epoch is `epoch`, else throws
   * `CheckpointFencedError` and writes nothing; runs `write`; writes the
   * checkpoint and the changes.
   */
  commit(
    key: CheckpointKey,
    epoch: FencingToken,
    checkpoint: StoredCheckpoint,
    changes: StateChanges,
    options?: SignalOption & { readonly write?: W },
  ): Promise<void>;
  /** The partitions of the group that have a checkpoint. */
  list(
    consumerGroup: string,
    options?: SignalOption & { readonly stream?: string },
  ): AsyncIterable<CheckpointSummary>;
  /**
   * Removes the checkpoint and the map states of one partition, or of each
   * partition of a stream, and raises the epoch of each key it removes.
   */
  reset(
    consumerGroup: string,
    target: { readonly stream: string; readonly partition?: string },
    options?: SignalOption,
  ): Promise<void>;
}
