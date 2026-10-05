import type { AcquireMode, Outcome, OutcomeResults } from './acquire-mode.ts';
import { WaitMode } from './acquire-modes/wait-mode.ts';
import { Key } from './key.ts';
import type { Lease } from './lease.ts';
import type { LockStore } from './lock-store.ts';

const wait = new WaitMode();

const ran = <T>(value: T): OutcomeResults<T> => ({
  always: value,
  maybe: { acquired: true, value },
});

// Only a mode that may give up can end without a lease. A mode whose outcome
// is 'always' and gives up breaks its contract, so reading its result throws.
const gaveUp = <T>(key: string): OutcomeResults<T> => ({
  get always(): T {
    throw new Error(
      `An acquire mode whose outcome is 'always' gave up on key "${key}".`,
    );
  },
  maybe: { acquired: false },
});

export class Mutex {
  readonly #store: LockStore;

  constructor(store: LockStore) {
    this.#store = store;
  }

  /** Runs `task` while holding `key`, and waits while the key is busy. */
  acquire<T>(
    key: string,
    task: (lease: Lease) => Promise<T>,
    options?: { mode?: undefined },
  ): Promise<T>;
  /** Runs `task` while holding `key`. The acquire mode decides what happens while the key is busy. */
  acquire<T, O extends Outcome>(
    key: string,
    task: (lease: Lease) => Promise<T>,
    options: { mode: AcquireMode<O> },
  ): Promise<OutcomeResults<T>[O]>;
  acquire<T, O extends Outcome>(
    key: string,
    task: (lease: Lease) => Promise<T>,
    { mode }: { mode?: AcquireMode<O> | undefined } = {},
  ): Promise<T | OutcomeResults<T>[O]> {
    return mode === undefined
      ? this.#run(key, task, wait)
      : this.#run(key, task, mode);
  }

  /** A key whose callers wait, unless one call says otherwise. */
  key(name: string, options?: { mode?: undefined }): Key<'always'>;
  /** A key whose callers use `mode`, unless one call says otherwise. */
  key<O extends Outcome>(
    name: string,
    options: { mode: AcquireMode<O> },
  ): Key<O>;
  key<O extends Outcome>(
    name: string,
    { mode }: { mode?: AcquireMode<O> | undefined } = {},
  ): Key<'always'> | Key<O> {
    return mode === undefined
      ? new Key(this, name, wait)
      : new Key(this, name, mode);
  }

  // `mode.outcome` has the type O, so TypeScript checks each result below
  // against OutcomeResults<T>[O] and needs no type assertion.
  async #run<T, O extends Outcome>(
    key: string,
    task: (lease: Lease) => Promise<T>,
    mode: AcquireMode<O>,
  ): Promise<OutcomeResults<T>[O]> {
    const lease = await mode.acquire(this.#store, key);
    if (!lease) return gaveUp<T>(key)[mode.outcome];

    await using held = lease;
    return ran(await task(held))[mode.outcome];
  }
}
