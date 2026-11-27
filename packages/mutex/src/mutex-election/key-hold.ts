import { Latch } from '@zukhruf/async';
import type { FencedLease } from '@zukhruf/fencing';

import type { AcquireMode, Outcome } from '../mutex/acquire-mode.ts';
import type { Key } from '../mutex/key.ts';

/** How the run of a hold ended: its task returned and the mutex released the key, or the run failed. */
type RunEnd = { failed: false } | { failed: true; error: unknown };

/**
 * One grant of a key, held open in the task of `Key.run`. Only the mutex
 * releases a key (ADR 0006), so the hold keeps that task waiting until `end`.
 */
export class KeyHold {
  readonly lease: FencedLease;
  readonly #released: Latch;
  readonly #ran: Latch<RunEnd>;

  private constructor(lease: FencedLease, released: Latch, ran: Latch<RunEnd>) {
    this.lease = lease;
    this.#released = released;
    this.#ran = ran;
  }

  /**
   * Resolves with the hold of a grant, or `undefined` when `mode` gives up.
   * Rejects when the acquire fails, or with `signal.reason` when `signal`
   * aborts first; a grant that comes after that goes back (`Mutex`).
   */
  static async acquire(
    key: Key<Outcome>,
    mode: AcquireMode,
    signal: AbortSignal | undefined,
  ): Promise<KeyHold | undefined> {
    const granted = new Latch<FencedLease>();
    const released = new Latch();
    const ran = new Latch<RunEnd>();
    const run = key.run(
      async (lease) => {
        granted.open(lease);
        await released.wait();
      },
      { mode, signal },
    );
    run.then(
      () => ran.open({ failed: false }),
      (error: unknown) => ran.open({ failed: true, error }),
    );
    // The task waits for `released`, so the run ends first only when the mode gave up or the acquire failed.
    const lease = await Promise.race([
      granted.wait(),
      run.then(() => undefined),
    ]);
    return lease === undefined ? undefined : new KeyHold(lease, released, ran);
  }

  /** Calls `lose` when the store takes the lease away, at once when it already did. */
  watch(lose: (reason: Error) => void): Disposable {
    const { signal } = this.lease;
    const onLoss = () => lose(signal.reason);
    if (signal.aborted) onLoss();
    else signal.addEventListener('abort', onLoss, { once: true });
    return {
      [Symbol.dispose]: () => signal.removeEventListener('abort', onLoss),
    };
  }

  /**
   * Lets the task return, so the mutex releases the key. Rejects with a
   * failure of the release. A loss of the lease is no failure here: the key
   * is the store's again.
   */
  async end(): Promise<void> {
    this.#released.open();
    const end = await this.#ran.wait();
    if (end.failed && end.error !== this.lease.signal.reason) throw end.error;
  }
}
