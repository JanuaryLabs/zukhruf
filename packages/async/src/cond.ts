import { Latch } from './latch.ts';
import { untilAborted } from './until-aborted.ts';
import { type WaitOptions } from './wait-options.ts';

/**
 * Wakes every caller that waits now. A broadcast ends each wait that
 * started before it, and keeps nothing for a later wait. A cond carries no
 * value: a woken caller checks its state again, and waits again when the
 * state has not changed. The name is the one of Go `sync.Cond`, without
 * its lock: a wait registers in the step of the call, so no broadcast can
 * come between the check of the state and the wait.
 */
export class Cond {
  /** Opens at the next broadcast. A new latch then takes its place for the waits after that broadcast. */
  #broadcast = new Latch();

  /**
   * Ends at the first broadcast after the call, also a broadcast in the
   * same step. When the signal aborts, also before the call, the wait
   * rejects with its reason.
   */
  async wait({ signal }: WaitOptions): Promise<void> {
    signal?.throwIfAborted();
    await untilAborted(this.#broadcast.wait(), signal);
  }

  /** Ends each wait that started before this call. With no wait, it changes nothing. */
  broadcast(): void {
    this.#broadcast.open();
    this.#broadcast = new Latch();
  }
}
