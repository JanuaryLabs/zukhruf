import { Latch } from '@zukhruf/async';

import { TermLostError } from './term-lost-error.ts';

/** What a term needs from its election to end: the backend's steps for the claim it won. */
export interface TermSteps {
  /** Starts watching the claim; `lose` reports that the backend took it away. */
  watch(lose: (reason: Error) => void): Disposable;
  /** Gives the claim up. Called only for a term that was not lost. */
  release(): Promise<void>;
  /** Frees the claim's resources. Called at each end. */
  close(): Promise<void>;
}

/** How a term ended, as data: a latch never rejects. */
type Ending = { failed: false } | { failed: true; error: unknown };

/**
 * One term of the elected leader. It ends when the leader resigns, when its
 * process dies, or when the backend takes the claim away. Only the last one
 * can happen while the leader still runs, and then `signal` aborts with
 * `TermLostError`.
 */
export class Term implements AsyncDisposable {
  /** Higher than the epoch of each earlier term, so a newer leader can always outrank an older one. */
  readonly epoch: bigint;
  readonly #steps: TermSteps;
  readonly #lost = new AbortController();
  /** Aborts once the term starts to end, by resign or by loss. */
  readonly #ending = new AbortController();
  readonly #ended = new Latch<Ending>();
  readonly #watching = new DisposableStack();

  constructor(epoch: bigint, steps: TermSteps) {
    this.epoch = epoch;
    this.#steps = steps;
    this.#watching.use(steps.watch((reason) => this.#lose(reason)));
  }

  /** Aborts with `TermLostError` when the term ends while its leader still runs. */
  get signal(): AbortSignal {
    return this.#lost.signal;
  }

  /**
   * Ends the term and gives the claim up. A second call waits for the first.
   * After a loss, it only waits until the claim's resources are free, and it
   * never rejects.
   */
  async resign(): Promise<void> {
    if (!this.#ending.signal.aborted) {
      this.#ending.abort();
      this.#ended.open(await this.#giveUp());
    }
    const ending = await this.#ended.wait();
    if (ending.failed) throw ending.error;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.resign();
  }

  #lose(reason: Error) {
    // A resign that began first ends the term; the claim was given up on purpose.
    if (this.#ending.signal.aborted) return;
    this.#ending.abort();
    this.#lost.abort(new TermLostError({ cause: reason }));
    // Freed one step later: a watch that reports a loss before it returns is
    // held by then, so it stops before its claim is freed.
    void Promise.resolve()
      .then(() => this.#freeLost())
      .then((ending) => this.#ended.open(ending));
  }

  async #giveUp(): Promise<Ending> {
    try {
      this.#watching.dispose();
      await this.#steps.release();
    } catch (error) {
      await this.#steps.close().catch(() => {});
      return { failed: true, error };
    }
    try {
      await this.#steps.close();
      return { failed: false };
    } catch (error) {
      return { failed: true, error };
    }
  }

  /**
   * A lost claim is no longer this term's to give up: a release could undo
   * the next leader's claim. Only its resources are freed, and a loss has no
   * caller to report a failure to.
   */
  async #freeLost(): Promise<Ending> {
    try {
      this.#watching.dispose();
    } finally {
      await this.#steps.close().catch(() => {});
    }
    return { failed: false };
  }
}
