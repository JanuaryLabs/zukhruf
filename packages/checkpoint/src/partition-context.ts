import type { FencingToken } from '@zukhruf/fencing';

import type { CheckpointStore } from './checkpoint-store.ts';
import type {
  Checkpoint,
  CheckpointKey,
  Format,
  SignalOption,
  StateChanges,
  StoredValue,
} from './checkpoint.ts';
import {
  type MapState,
  MapStateView,
  type PendingChanges,
} from './map-state.ts';

/**
 * What a claim gives (ADR 0005): the checkpoint key, the epoch of the claim,
 * the checkpoint that the claim read, the map states and the commit.
 */
export class PartitionContext<P, W> {
  readonly consumerGroup: string;
  readonly stream: string;
  readonly partition: string;
  readonly epoch: FencingToken;
  /**
   * The checkpoint that the claim read, or undefined when the partition had
   * none. A commit gives the new checkpoint.
   */
  readonly checkpoint: Checkpoint<P> | undefined;
  readonly #store: CheckpointStore<W>;
  readonly #key: CheckpointKey;
  readonly #format: Format<P>;
  readonly #pending = new Map<string, PendingChanges>();
  #checkpointId: number;

  constructor(
    store: CheckpointStore<W>,
    key: CheckpointKey,
    epoch: FencingToken,
    format: Format<P>,
    checkpoint: Checkpoint<P> | undefined,
  ) {
    this.#store = store;
    this.#key = key;
    this.consumerGroup = key.consumerGroup;
    this.stream = key.stream;
    this.partition = key.partition;
    this.epoch = epoch;
    this.#format = format;
    this.checkpoint = checkpoint;
    this.#checkpointId = checkpoint?.checkpointId ?? 0;
  }

  /**
   * The map state of `name` in this partition (ADR 0006). Each call gives a
   * view over the same values and changes, read and written with `format`.
   */
  state<V>(name: string, format: Format<V>): MapState<V> {
    return new MapStateView(
      this.#store,
      this.#key,
      name,
      format,
      this.#pending,
    );
  }

  /**
   * Saves the position, the changes of each map state and the next checkpoint
   * id, all of them or none (ADR 0007). With `write`, the store runs it in the
   * same transaction, after it checks the epoch. A commit that throws keeps
   * the changes, so that a retry commits them.
   */
  async commit(
    position: P,
    options?: SignalOption & { readonly write?: W },
  ): Promise<Checkpoint<P>> {
    options?.signal?.throwIfAborted();
    const checkpointId = this.#checkpointId + 1;
    await this.#store.commit(
      this.#key,
      this.epoch,
      {
        checkpointId,
        version: this.#format.version,
        json: this.#format.encode(position),
      },
      this.#changes(),
      options,
    );
    this.#pending.clear();
    this.#checkpointId = checkpointId;
    return { position, checkpointId };
  }

  #changes(): StateChanges {
    const cleared = new Set<string>();
    const deleted = new Map<string, ReadonlySet<string>>();
    const set = new Map<string, ReadonlyMap<string, StoredValue>>();
    for (const [name, pending] of this.#pending) {
      if (pending.kind === 'replace') cleared.add(name);
      const removed = new Set<string>();
      const written = new Map<string, StoredValue>();
      for (const [key, value] of pending.values) {
        if (value === null) removed.add(key);
        else written.set(key, value);
      }
      if (removed.size > 0) deleted.set(name, removed);
      if (written.size > 0) set.set(name, written);
    }
    return { cleared, deleted, set };
  }
}
