import { Future } from '@zukhruf/async';
import { type Lease, LeaseController } from '@zukhruf/lease';

import { TermWarning } from './term-warning.ts';

/** What a term needs from its election to end: the backend's steps for the claim it won. */
export interface TermSteps {
  /** Starts watching the claim; `lose` reports that the backend took it away. */
  watch(lose: (reason: Error) => void): Disposable;
  /**
   * Records that the term resigned clean, while it still holds the claim.
   * Called only for a term that was not lost, before `release`.
   */
  recordCleanShutdown(): Promise<void>;
  /** Gives the claim up. Called only for a term that was not lost. */
  release(): Promise<void>;
  /** Frees the claim's resources. Called at each end. */
  close(): Promise<void>;
}

export interface ResignOptions {
  /**
   * The leader says that it leaves nothing for its successor to recover,
   * for example no work in progress. The next term then reads
   * `afterCleanShutdown` as true. A lost term never says it.
   */
  clean: boolean;
}

/**
 * One term of the elected leader: a lease on leadership. It ends when the
 * leader resigns, when its process dies, or when the backend takes the claim
 * away. Only the last one can happen while the leader still runs, and then
 * `signal` aborts with `LeaseLostError`.
 */
export class Term implements Lease, AsyncDisposable {
  /** Higher than the epoch of each earlier term, so a newer leader can always outrank an older one. */
  readonly epoch: bigint;
  /**
   * True only when the term just before this one resigned clean: its leader
   * left nothing to recover. False after a crash, a lost term, a resign that
   * did not say it was clean, and for the first term.
   */
  readonly afterCleanShutdown: boolean;
  /** The name of the election that elected this term, for the detail of a warning. */
  readonly #election: string;
  readonly #steps: TermSteps;
  readonly #lease = new LeaseController('leadership');
  /** Aborts once the term starts to end, by resign or by loss. */
  readonly #ending = new AbortController();
  readonly #ended = new Future<void>();
  readonly #watching = new DisposableStack();

  constructor(
    {
      epoch,
      afterCleanShutdown,
      election,
    }: Pick<Term, 'epoch' | 'afterCleanShutdown'> & { election: string },
    steps: TermSteps,
  ) {
    this.epoch = epoch;
    this.afterCleanShutdown = afterCleanShutdown;
    this.#election = election;
    this.#steps = steps;
    this.#watching.use(steps.watch((reason) => this.#lose(reason)));
  }

  /** Aborts with `LeaseLostError` when the term ends while its leader still runs. */
  get signal(): AbortSignal {
    return this.#lease.signal;
  }

  /**
   * Ends the term and gives the claim up. With `clean`, it first records a
   * clean shutdown for the next term. A second call waits for the first, and
   * its options do nothing. When a step fails and freeing the claim fails
   * too, it rejects with a `SuppressedError`: its `suppressed` is the step's
   * error, and its `error` is the failure to free. After a loss, it only waits
   * until the claim's resources are free, records nothing, and never rejects.
   */
  async resign(options?: ResignOptions): Promise<void> {
    if (!this.#ending.signal.aborted) {
      this.#ending.abort();
      this.#lease.end();
      try {
        await this.#giveUp(options?.clean === true);
        this.#ended.resolve();
      } catch (error) {
        this.#ended.reject(error);
      }
    }
    await this.#ended.wait();
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.resign();
  }

  #lose(reason: Error) {
    // After a resign began, the lease ignores the loss: the leader gave the
    // claim up on purpose, so it is not told.
    this.#lease.lose(reason);
    // The claim is freed once, by the resign or by the first loss.
    if (this.#ending.signal.aborted) return;
    this.#ending.abort();
    // Freed one step later: a watch that reports a loss before it returns is
    // held by then, so it stops before its claim is freed.
    void Promise.resolve()
      .then(() => this.#freeLost())
      .then(() => this.#ended.resolve());
  }

  async #giveUp(clean: boolean): Promise<void> {
    try {
      this.#watching.dispose();
      // Before the release: until then no other candidate can hold the claim.
      if (clean) await this.#steps.recordCleanShutdown();
      await this.#steps.release();
    } catch (error) {
      await using closing = new AsyncDisposableStack();
      closing.defer(() => this.#steps.close());
      throw error;
    }
    await this.#steps.close();
  }

  /**
   * A lost claim is no longer this term's to give up: a release could undo
   * the next leader's claim. It only stops watching and frees the claim's
   * resources. A loss has no caller to report a failure to, so a failure of
   * either step is a process warning, and the term still ends. When both
   * fail, the warning is a `SuppressedError` of the failure to free over the
   * failure to stop watching.
   */
  async #freeLost(): Promise<void> {
    try {
      await using freeing = new AsyncDisposableStack();
      freeing.defer(() => this.#steps.close());
      this.#watching.dispose();
    } catch (error) {
      process.emitWarning(
        new TermWarning(error, { election: this.#election, epoch: this.epoch }),
      );
    }
  }
}
