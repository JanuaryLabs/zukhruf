import type { CheckpointStore } from './checkpoint-store.ts';
import type {
  CheckpointKey,
  Format,
  SignalOption,
  StoredValue,
} from './checkpoint.ts';
import { IncompatibleCheckpointError } from './errors.ts';

/**
 * The values of one name in a partition, one value for each key (ADR 0006).
 * Reads give the committed values with this context's changes over them.
 * Changes stay in memory until the next commit.
 */
export interface MapState<V> {
  get(key: string, options?: SignalOption): Promise<V | undefined>;
  has(key: string, options?: SignalOption): Promise<boolean>;
  entries(options?: SignalOption): AsyncIterable<[key: string, value: V]>;
  set(key: string, value: V): void;
  delete(key: string): void;
  clear(): void;
}

/**
 * The changes of one map state since the last commit, encoded as the store
 * keeps them; `null` is a deleted key. `over` lays them over the committed
 * values. `replace` is the state after a clear: the committed values are gone.
 */
export type PendingChanges = {
  readonly kind: 'over' | 'replace';
  readonly values: Map<string, StoredValue | null>;
};

/** One typed view of a map state; the context holds its changes. */
export class MapStateView<V, W> implements MapState<V> {
  readonly #store: CheckpointStore<W>;
  readonly #key: CheckpointKey;
  readonly #name: string;
  readonly #format: Format<V>;
  readonly #pending: Map<string, PendingChanges>;

  constructor(
    store: CheckpointStore<W>,
    key: CheckpointKey,
    name: string,
    format: Format<V>,
    pending: Map<string, PendingChanges>,
  ) {
    this.#store = store;
    this.#key = key;
    this.#name = name;
    this.#format = format;
    this.#pending = pending;
  }

  async get(key: string, options?: SignalOption): Promise<V | undefined> {
    options?.signal?.throwIfAborted();
    const pending = this.#pending.get(this.#name);
    const change = pending?.values.get(key);
    if (change !== undefined)
      return change === null ? undefined : this.#decode(change);
    if (pending?.kind === 'replace') return undefined;
    const stored = await this.#store.get(this.#key, this.#name, [key], options);
    const value = stored.get(key);
    return value === undefined ? undefined : this.#decode(value);
  }

  async has(key: string, options?: SignalOption): Promise<boolean> {
    options?.signal?.throwIfAborted();
    const pending = this.#pending.get(this.#name);
    const change = pending?.values.get(key);
    if (change !== undefined) return change !== null;
    if (pending?.kind === 'replace') return false;
    const stored = await this.#store.get(this.#key, this.#name, [key], options);
    return stored.has(key);
  }

  async *entries(options?: SignalOption): AsyncIterable<[string, V]> {
    options?.signal?.throwIfAborted();
    const pending = this.#pending.get(this.#name);
    if (pending?.kind !== 'replace') {
      for await (const [key, value] of this.#store.scan(
        this.#key,
        this.#name,
        options,
      )) {
        if (!pending?.values.has(key)) yield [key, this.#decode(value)];
      }
    }
    for (const [key, change] of pending?.values ?? []) {
      if (change !== null) yield [key, this.#decode(change)];
    }
  }

  set(key: string, value: V): void {
    this.#changes().set(key, {
      version: this.#format.version,
      json: this.#format.encode(value),
    });
  }

  delete(key: string): void {
    this.#changes().set(key, null);
  }

  clear(): void {
    this.#pending.set(this.#name, { kind: 'replace', values: new Map() });
  }

  #changes(): Map<string, StoredValue | null> {
    const pending = this.#pending.get(this.#name);
    if (pending !== undefined) return pending.values;
    const values = new Map<string, StoredValue | null>();
    this.#pending.set(this.#name, { kind: 'over', values });
    return values;
  }

  #decode(value: StoredValue): V {
    try {
      return this.#format.decode(value.version, value.json);
    } catch (cause) {
      throw new IncompatibleCheckpointError(this.#key, value.version, cause);
    }
  }
}
