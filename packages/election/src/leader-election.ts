import { type Clock, timeout as deadlineAfter } from '@zukhruf/async';

import { Term } from './term.ts';

export interface CampaignOptions {
  /**
   * Milliseconds to keep trying before conceding to the current leader.
   * Defaults to one attempt. `Infinity` waits until the campaign wins or its
   * signal aborts.
   */
  timeout?: number | undefined;
  /** Stops the campaign, which then rejects with `signal.reason`. A term won after it aborted is given up. */
  signal?: AbortSignal | undefined;
}

/**
 * Elects one leader among candidates. The campaign is the same for each
 * backend: open an attempt, try the claim, wait for a change that lets a try
 * win, try again until the claim is won or the time is up, watch the won
 * claim, and hand it to a term. Each backend is a subclass that implements
 * the steps for its claim.
 *
 * A backend keeps six rules:
 * - `tryClaim` returns the epoch of the term it won, in the same step, and
 *   each epoch is higher than every earlier one and below 2^31.
 * - `tryClaim` reports `afterCleanShutdown` only when the term just before
 *   it recorded a clean shutdown with `recordCleanShutdown`, and it reports
 *   each record once.
 * - `watch` calls `lose` before the backend can grant the claim to another
 *   candidate, so an old leader stops before a new one starts.
 * - `release` is never called after a loss: the claim may be another
 *   candidate's by then.
 * - `close` frees the attempt's resources, after each end.
 * - `waitForChange` settles when its signal aborts, and never ends the
 *   attempt itself.
 */
export abstract class LeaderElection<Claim> {
  /** The clock of the campaign: `globalThis` in production, a fake clock in a test. */
  protected readonly clock: Clock;

  protected constructor(clock: Clock) {
    this.clock = clock;
  }

  /** Resolves with the new term, or `undefined` when another candidate still leads after `timeout`. */
  async campaign({ timeout = 0, signal }: CampaignOptions = {}): Promise<
    Term | undefined
  > {
    signal?.throwIfAborted();
    const deadline = this.clock.performance.now() + timeout;
    for (;;) {
      const outcome = await this.#attempt(deadline, signal);
      // A claim lost before its term began is no term: try again with a new attempt.
      if (outcome !== 'lost') return outcome;
    }
  }

  /** Prepares one attempt: the resources that `tryClaim` uses again and again. */
  protected abstract open(signal: AbortSignal | undefined): Promise<Claim>;

  /**
   * Tries the claim once. Resolves with the epoch of the term it won and
   * whether the term before it resigned clean, or `undefined` while another
   * candidate holds it.
   */
  protected abstract tryClaim(
    claim: Claim,
    signal: AbortSignal | undefined,
  ): Promise<Pick<Term, 'epoch' | 'afterCleanShutdown'> | undefined>;

  /**
   * Resolves when a try of the claim can win: the holder left, was ended,
   * or the backend wants a new try. Settles when `signal` aborts.
   */
  protected abstract waitForChange(
    claim: Claim,
    signal: AbortSignal,
  ): Promise<void>;

  /** Watches a won claim for as long as its term lasts, and calls `lose` when the backend takes it away. */
  protected abstract watch(
    claim: Claim,
    lose: (reason: Error) => void,
  ): Disposable;

  /**
   * Records that the term of `epoch` resigned clean, so that the next
   * `tryClaim` reports it. Called while the claim is held, before `release`,
   * and never after a loss.
   */
  protected abstract recordCleanShutdown(
    claim: Claim,
    epoch: bigint,
  ): Promise<void>;

  /** Gives a won claim up. Never called after a loss. */
  protected abstract release(claim: Claim): Promise<void>;

  /** Frees the resources of an attempt, whether it won, lost or failed. */
  protected abstract close(claim: Claim): Promise<void>;

  async #attempt(
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<Term | 'lost' | undefined> {
    const claim = await this.open(signal);
    let won: Pick<Term, 'epoch' | 'afterCleanShutdown'> | undefined;
    try {
      won = await this.#tryUntil(claim, deadline, signal);
    } catch (error) {
      await this.close(claim).catch(() => {});
      throw error;
    }
    if (won === undefined) {
      await this.close(claim);
      return undefined;
    }
    return this.#begin(claim, won, signal);
  }

  /** Tries the claim, and after each try that does not win, waits for a change, until the deadline gives one last try. */
  async #tryUntil(
    claim: Claim,
    deadline: number,
    signal: AbortSignal | undefined,
  ): Promise<Pick<Term, 'epoch' | 'afterCleanShutdown'> | undefined> {
    for (;;) {
      const won = await this.tryClaim(claim, signal);
      if (won !== undefined) return won;
      const left = deadline - this.clock.performance.now();
      if (left <= 0) return undefined;
      await this.#waitForChange(claim, left, signal);
    }
  }

  /** Waits for the backend's change, up to `left` milliseconds; rejects with `signal.reason` when the caller leaves. */
  async #waitForChange(
    claim: Claim,
    left: number,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    using limit =
      left === Infinity
        ? undefined
        : deadlineAfter(left, { clock: this.clock });
    const stops = [signal, limit?.signal].filter((stop) => stop !== undefined);
    const wait = AbortSignal.any(stops);
    try {
      await this.waitForChange(claim, wait);
    } catch (error) {
      // After an abort, the backend settles as it can; the deadline gives one last try.
      if (!wait.aborted) throw error;
    }
    signal?.throwIfAborted();
  }

  /** Hands a won claim to its term, or gives it up when the caller left meanwhile. */
  async #begin(
    claim: Claim,
    won: Pick<Term, 'epoch' | 'afterCleanShutdown'>,
    signal: AbortSignal | undefined,
  ): Promise<Term | 'lost'> {
    let term: Term;
    try {
      signal?.throwIfAborted();
      term = new Term(won, {
        watch: (lose) => this.watch(claim, lose),
        recordCleanShutdown: () => this.recordCleanShutdown(claim, won.epoch),
        release: () => this.release(claim),
        close: () => this.close(claim),
      });
    } catch (error) {
      await this.release(claim).catch(() => {});
      await this.close(claim).catch(() => {});
      throw error;
    }
    return term.signal.aborted ? 'lost' : term;
  }
}
