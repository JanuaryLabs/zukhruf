import { LeaseLostError } from './lease-lost-error.ts';

/**
 * The issuer's side of one lease. The issuer keeps the controller and gives
 * the holder only `signal`, as an `AbortController` keeps its abort and
 * gives out its `AbortSignal`.
 */
export class LeaseController {
  readonly #subject: string;
  readonly #lost = new AbortController();
  /** Aborts once the lease ends, by a loss or by `end()`. */
  readonly #ended = new AbortController();

  constructor(subject: string) {
    this.#subject = subject;
  }

  get signal(): AbortSignal {
    return this.#lost.signal;
  }

  /**
   * Another holder may have the right now. Aborts `signal` with a
   * `LeaseLostError` that carries `cause`, when one is given. A lease is lost
   * at most once, and never after it ended: a released right is not this
   * holder's to lose.
   */
  lose(cause?: unknown): void {
    if (this.#ended.signal.aborted) return;
    this.#ended.abort();
    this.#lost.abort(
      new LeaseLostError(
        this.#subject,
        cause === undefined ? undefined : { cause },
      ),
    );
  }

  /** The holder released the lease. `signal` keeps its state, and a later `lose` does nothing. */
  end(): void {
    this.#ended.abort();
  }
}
