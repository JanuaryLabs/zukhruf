import type { FencedLease } from '@zukhruf/fencing';

import type { AcquireMode, Outcome } from '../mutex/acquire-mode.ts';
import type { Key } from '../mutex/key.ts';
import { KeyHold } from './key-hold.ts';

/** The attempt holds no grant: it has not got one yet, its mode gave up, or it gave the grant back. */
class Ungranted {}

const UNGRANTED = new Ungranted();

/** The attempt holds a grant. */
class Granted {
  readonly hold: KeyHold;

  constructor(hold: KeyHold) {
    this.hold = hold;
  }
}

/**
 * One attempt of a candidate over a key, and the grant that it holds. A
 * grant that a wait for a change got stays here for the next try to take.
 */
export class KeyAttempt {
  #state: Ungranted | Granted = UNGRANTED;

  /** Keeps the grant that the attempt holds, or acquires one with `mode`. Resolves with its lease, or `undefined` when `mode` gives up. */
  async take(
    key: Key<Outcome>,
    mode: AcquireMode,
    signal: AbortSignal | undefined,
  ): Promise<FencedLease | undefined> {
    if (this.#state instanceof Granted) return this.#state.hold.lease;
    const hold = await KeyHold.acquire(key, mode, signal);
    if (hold === undefined) return undefined;
    this.#state = new Granted(hold);
    return hold.lease;
  }

  /** Watches the grant of a won claim. */
  watch(lose: (reason: Error) => void): Disposable {
    if (!(this.#state instanceof Granted))
      throw new Error('This attempt holds no grant to watch.');
    return this.#state.hold.watch(lose);
  }

  /** Gives the grant back, once: a later call, as the close after a release, does nothing. */
  async giveUp(): Promise<void> {
    const state = this.#state;
    this.#state = UNGRANTED;
    if (state instanceof Granted) await state.hold.end();
  }
}
