import { FencingToken } from '@zukhruf/fencing';

import type { CheckpointStore } from './checkpoint-store.ts';
import type {
  CheckpointKey,
  CheckpointSummary,
  SignalOption,
  StateChanges,
  StoredCheckpoint,
  StoredValue,
} from './checkpoint.ts';
import { CheckpointFencedError } from './errors.ts';

type Row = {
  readonly key: CheckpointKey;
  epoch: bigint;
  checkpoint: StoredCheckpoint | undefined;
  readonly states: Map<string, Map<string, StoredValue>>;
};

/**
 * Keeps checkpoints in the memory of this process (ADR 0011). A commit has no
 * transaction for an output, so it takes no `write`.
 */
export class MemoryCheckpointStore implements CheckpointStore<never> {
  readonly #rows = new Map<string, Row>();

  async claim(
    key: CheckpointKey,
    options?: SignalOption,
  ): Promise<FencingToken> {
    options?.signal?.throwIfAborted();
    const row = this.#row(key);
    row.epoch += 1n;
    return new FencingToken(row.epoch);
  }

  async read(
    key: CheckpointKey,
    options?: SignalOption,
  ): Promise<StoredCheckpoint | undefined> {
    options?.signal?.throwIfAborted();
    return this.#rows.get(id(key))?.checkpoint;
  }

  async get(
    key: CheckpointKey,
    state: string,
    keys: readonly string[],
    options?: SignalOption,
  ): Promise<ReadonlyMap<string, StoredValue>> {
    options?.signal?.throwIfAborted();
    const values = this.#rows.get(id(key))?.states.get(state);
    const found = new Map<string, StoredValue>();
    for (const name of keys) {
      const value = values?.get(name);
      if (value !== undefined) found.set(name, value);
    }
    return found;
  }

  async *scan(
    key: CheckpointKey,
    state: string,
    options?: SignalOption,
  ): AsyncIterable<readonly [string, StoredValue]> {
    options?.signal?.throwIfAborted();
    const values = this.#rows.get(id(key))?.states.get(state);
    if (values !== undefined) yield* [...values];
  }

  async commit(
    key: CheckpointKey,
    epoch: FencingToken,
    checkpoint: StoredCheckpoint,
    changes: StateChanges,
    options?: SignalOption & { readonly write?: never },
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    const row = this.#rows.get(id(key));
    if (row === undefined || row.epoch !== epoch.value)
      throw new CheckpointFencedError(key, epoch);
    for (const name of changes.cleared) row.states.delete(name);
    for (const [name, keys] of changes.deleted) {
      const values = row.states.get(name);
      for (const deleted of keys) values?.delete(deleted);
    }
    for (const [name, values] of changes.set) {
      const stored = row.states.get(name) ?? new Map<string, StoredValue>();
      for (const [value, json] of values) stored.set(value, json);
      row.states.set(name, stored);
    }
    row.checkpoint = checkpoint;
  }

  async *list(
    consumerGroup: string,
    options?: SignalOption & { readonly stream?: string },
  ): AsyncIterable<CheckpointSummary> {
    options?.signal?.throwIfAborted();
    for (const row of this.#rows.values()) {
      const { stream, partition } = row.key;
      if (row.key.consumerGroup !== consumerGroup) continue;
      if (row.checkpoint === undefined) continue;
      if (options?.stream !== undefined && stream !== options.stream) continue;
      yield {
        stream,
        partition,
        checkpointId: row.checkpoint.checkpointId,
        epoch: new FencingToken(row.epoch),
      };
    }
  }

  async reset(
    consumerGroup: string,
    target: { readonly stream: string; readonly partition?: string },
    options?: SignalOption,
  ): Promise<void> {
    options?.signal?.throwIfAborted();
    for (const row of this.#rows.values()) {
      const { stream, partition } = row.key;
      if (row.key.consumerGroup !== consumerGroup) continue;
      if (stream !== target.stream) continue;
      if (target.partition !== undefined && partition !== target.partition)
        continue;
      row.epoch += 1n;
      row.checkpoint = undefined;
      row.states.clear();
    }
  }

  #row(key: CheckpointKey): Row {
    const rowId = id(key);
    const existing = this.#rows.get(rowId);
    if (existing !== undefined) return existing;
    const row: Row = {
      key,
      epoch: 0n,
      checkpoint: undefined,
      states: new Map(),
    };
    this.#rows.set(rowId, row);
    return row;
  }
}

function id(key: CheckpointKey): string {
  return JSON.stringify([key.consumerGroup, key.stream, key.partition]);
}
