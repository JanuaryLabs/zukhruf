import type { AcquireMode, Outcome, OutcomeResults } from './acquire-mode.ts';
import type { Lease } from './lease.ts';
import type { AcquireOptions } from './lock-store.ts';
import type { Mutex } from './mutex.ts';

/**
 * A key with the acquire mode that its callers use unless one call says
 * otherwise. Build it with `mutex.key(name, { mode })`. `O` is the outcome of
 * that mode.
 */
export class Key<O extends Outcome> {
  readonly name: string;
  readonly #mutex: Mutex;
  readonly #mode: AcquireMode<O>;

  constructor(mutex: Mutex, name: string, mode: AcquireMode<O>) {
    this.#mutex = mutex;
    this.name = name;
    this.#mode = mode;
  }

  /** Whether the key has a holder now, learned without acquiring it. The holder can change before the answer arrives. */
  isHeld(): Promise<boolean> {
    return this.#mutex.isHeld(this.name);
  }

  /** Runs `task` with the key's own acquire mode. */
  run<T>(
    task: (lease: Lease) => Promise<T>,
    options?: AcquireOptions & { mode?: undefined },
  ): Promise<OutcomeResults<T>[O]>;
  /** Runs `task` with `mode` instead of the key's own acquire mode. */
  run<T, P extends Outcome>(
    task: (lease: Lease) => Promise<T>,
    options: AcquireOptions & { mode: AcquireMode<P> },
  ): Promise<OutcomeResults<T>[P]>;
  run<T, P extends Outcome>(
    task: (lease: Lease) => Promise<T>,
    {
      mode,
      signal,
    }: AcquireOptions & { mode?: AcquireMode<P> | undefined } = {},
  ): Promise<OutcomeResults<T>[O] | OutcomeResults<T>[P]> {
    return mode === undefined
      ? this.#mutex.acquire(this.name, task, { mode: this.#mode, signal })
      : this.#mutex.acquire(this.name, task, { mode, signal });
  }
}
