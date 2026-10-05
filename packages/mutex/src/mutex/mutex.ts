import type { AcquireMode, ModeResult } from './acquire-mode.ts';
import { WaitMode } from './acquire-modes/wait-mode.ts';
import { Key } from './key.ts';
import type { Lease } from './lease.ts';
import type { LockStore } from './lock-store.ts';

const wait = new WaitMode();

export class Mutex {
  readonly #store: LockStore;

  constructor(store: LockStore) {
    this.#store = store;
  }

  /** Runs `task` while holding `key`. The acquire mode decides what happens while the key is busy. */
  async acquire<T, M extends AcquireMode = WaitMode>(
    key: string,
    task: (lease: Lease) => Promise<T>,
    { mode }: { mode?: M } = {},
  ): Promise<ModeResult<M, T>> {
    const chosen: AcquireMode = mode ?? wait;
    const lease = await chosen.acquire(this.#store, key);
    if (!lease) return { acquired: false } as ModeResult<M, T>;

    await using held = lease;
    const value = await task(held);
    return (
      chosen.outcome === 'always' ? value : { acquired: true, value }
    ) as ModeResult<M, T>;
  }

  /** A key whose callers use `mode` unless one call says otherwise. Defaults to waiting. */
  key<D extends AcquireMode = WaitMode>(
    name: string,
    { mode }: { mode?: D } = {},
  ): Key<D> {
    return new Key(this, name, mode ?? (wait as AcquireMode as D));
  }
}
