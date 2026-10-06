import type { Lease } from './lease.ts';
import type { AcquireOptions, LockStore } from './lock-store.ts';

/** Whether an acquire mode always ends with the key held, or may give up. */
export type Outcome = 'always' | 'maybe';

/**
 * What one caller does while its key is busy. Exclusivity never depends on
 * the acquire mode, so callers of one key can use different modes.
 */
export interface AcquireMode<O extends Outcome = Outcome> {
  readonly outcome: O;
  /**
   * Resolves with a lease, or `undefined` when this caller gives up. Pass
   * `signal` on to each wait, so that a cancel stops the wait at once.
   */
  acquire(
    store: LockStore,
    key: string,
    options: AcquireOptions,
  ): Promise<Lease | undefined>;
}

export interface Acquired<T> {
  readonly acquired: true;
  readonly value: T;
}

export interface NotAcquired {
  readonly acquired: false;
}

/** What a run gives back, for each outcome. */
export interface OutcomeResults<T> {
  /** A mode that always acquires gives the task's value. */
  always: T;
  /** A mode that may give up says whether it acquired. */
  maybe: Acquired<T> | NotAcquired;
}

/** The result of a run with mode `M`. */
export type ModeResult<
  M extends AcquireMode,
  T,
> = OutcomeResults<T>[M['outcome']];
