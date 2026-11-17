import { Latch } from './latch.ts';
import { untilAborted } from './until-aborted.ts';

export interface WaitOptions {
  /** Cancels the wait: the wait rejects with `signal.reason`. The count does not change. */
  signal: AbortSignal | undefined;
}

/**
 * Counts the work in flight, and lets callers wait until the count is zero.
 * Each `add` gives a token, and the group counts the token until a dispose.
 * The count can go up again after zero, as a Go `sync.WaitGroup` can: each
 * time the count reaches zero, each wait that started before that zero
 * ends.
 */
export class WaitGroup {
  /** The tokens that their holders have not disposed yet, so a second dispose of one token counts nothing. */
  readonly #tokens = new Set<Disposable>();
  /** Opens when the count next reaches zero. A new latch then takes its place for the waits after that zero. */
  #zero = new Latch();

  /** Counts one more work until the token is disposed: `using _work = group.add()`. */
  add(): Disposable {
    const token: Disposable = {
      [Symbol.dispose]: () => {
        if (this.#tokens.delete(token) && this.#tokens.size === 0) {
          this.#zero.open();
          this.#zero = new Latch();
        }
      },
    };
    this.#tokens.add(token);
    return token;
  }

  /**
   * Ends at once when the count is zero, else when the count next reaches
   * zero, also when an `add` follows in the same step. When the signal
   * aborts, also before the call, the wait rejects with its reason.
   */
  async wait({ signal }: WaitOptions): Promise<void> {
    signal?.throwIfAborted();
    if (this.#tokens.size === 0) return;
    await untilAborted(this.#zero.wait(), signal);
  }
}
