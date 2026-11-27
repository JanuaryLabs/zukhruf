import {
  BackgroundService,
  type Backoff,
  type Clock,
  Latch,
  delay,
  untilAborted,
} from '@zukhruf/async';

import type { LeaderElection } from './leader-election.ts';
import { LeaderSelectorWarning } from './leader-selector-warning.ts';
import type { Term } from './term.ts';

export interface LeaderSelectorListener {
  /** Return, or reject with `signal.reason`, to give the leadership up. */
  takeLeadership(term: Term, signal: AbortSignal): Promise<void>;
}

export interface LeaderSelectorOptions {
  /** Without it, the selector leads once and then waits for `requeue()`. */
  autoRequeue?: { backoff: Backoff; clock: Clock } | undefined;
}

/**
 * Runs a task each time this process wins a term of an election, and
 * resigns the term when the task ends. With `autoRequeue`, it campaigns
 * again, until its dispose. Apache Curator's `LeaderSelector`, over a
 * `LeaderElection` as client-go's `LeaderElector` is over a
 * `resourcelock.Interface` (ADR 0011).
 */
export class LeaderSelector implements AsyncDisposable {
  readonly #election: LeaderElection<unknown>;
  readonly #listener: LeaderSelectorListener;
  readonly #requeue: Requeue;
  readonly #disposed = new AbortController();
  #state: Queued | Leading | Idle | Ended = QUEUED;
  readonly #rounds: BackgroundService;

  private constructor(
    election: LeaderElection<unknown>,
    listener: LeaderSelectorListener,
    requeue: Requeue,
  ) {
    this.#election = election;
    this.#listener = listener;
    this.#requeue = requeue;
    this.#rounds = BackgroundService.start((stop) => this.#run(stop));
  }

  /** Campaigns at once, and runs `listener.takeLeadership` with each term that it wins. */
  static start(
    election: LeaderElection<unknown>,
    listener: LeaderSelectorListener,
    { autoRequeue }: LeaderSelectorOptions = {},
  ): LeaderSelector {
    return new LeaderSelector(
      election,
      listener,
      autoRequeue === undefined
        ? new RequeueOnCall()
        : new AutoRequeue(autoRequeue, election.name),
    );
  }

  /** True while `takeLeadership` runs. */
  get hasLeadership(): boolean {
    return this.#state instanceof Leading;
  }

  /** Resolves at a clean end, and rejects with the failure that ended the selector. */
  get ended(): Promise<void> {
    return this.#rounds.ended;
  }

  /** Queues one more round. False when a round is queued or runs. Throws after the dispose, and after a failure ended the selector. */
  requeue(): boolean {
    if (this.#disposed.signal.aborted)
      throw new Error('This leader selector is disposed.');
    if (this.#state instanceof Ended)
      throw new Error('This leader selector ended, so it leads no more.');
    if (!(this.#state instanceof Idle)) return false;
    this.#state.requeued.open();
    this.#state = QUEUED;
    return true;
  }

  /** Aborts the signal of the running task. Does nothing while the selector does not lead. */
  interruptLeadership(): void {
    if (this.#state instanceof Leading) this.#state.interrupt.abort();
  }

  /** Aborts the selector, and waits until the task ended and the term was resigned. */
  [Symbol.asyncDispose](): Promise<void> {
    this.#disposed.abort();
    return this.#rounds[Symbol.asyncDispose]();
  }

  async #run(stop: AbortSignal): Promise<void> {
    try {
      await this.#loop(stop);
    } finally {
      this.#state = ENDED;
    }
  }

  async #loop(stop: AbortSignal): Promise<void> {
    while (!stop.aborted) {
      const state = this.#state;
      if (state instanceof Idle)
        await untilAborted(state.requeued.wait(), stop);
      let term: Term;
      try {
        // A campaign with no time limit resolves only with a term.
        term = (await this.#election.campaign({
          timeout: Infinity,
          signal: stop,
        }))!;
      } catch (failure) {
        if (stop.aborted && failure === stop.reason) throw failure;
        await this.#requeue.afterFailedCampaign(failure, stop);
        continue;
      }
      await this.#lead(term, stop);
      this.#state = this.#requeue.afterTerm();
    }
  }

  /**
   * Runs the task while the term lasts, and resigns the term after it. The
   * signal of the task aborts at the dispose, at `interruptLeadership()` and
   * at a loss. Only a failure of the task, or of the resign, rejects.
   */
  async #lead(won: Term, stop: AbortSignal): Promise<void> {
    await using term = won;
    const interrupt = new AbortController();
    const signal = AbortSignal.any([stop, interrupt.signal, term.signal]);
    this.#state = new Leading(interrupt);
    try {
      await this.#listener.takeLeadership(term, signal);
    } catch (error) {
      // The loss ended the task, whatever the task did after it.
      if (term.signal.aborted) return;
      // The task gave the leadership up as it was asked to.
      if (signal.aborted && error === signal.reason) return;
      throw error;
    } finally {
      this.#state = QUEUED;
    }
  }
}

/** What the selector does after a term and after a failed campaign: Curator's `autoRequeue`, or a wait for `requeue()`. */
interface Requeue {
  /** The state of the selector after a term ended. */
  afterTerm(): Queued | Idle;
  /** Resolves when the next campaign may start, or rejects to end the selector. */
  afterFailedCampaign(failure: unknown, stop: AbortSignal): Promise<void>;
}

/** Without `autoRequeue`: the selector waits for `requeue()` after each term, and a failed campaign ends it. */
class RequeueOnCall implements Requeue {
  afterTerm(): Idle {
    return new Idle();
  }

  async afterFailedCampaign(failure: unknown): Promise<void> {
    throw failure;
  }
}

/**
 * With `autoRequeue`: the selector campaigns again after each term, and
 * after a failed campaign it warns and waits the `backoff` duration of the
 * failed campaigns since the last term, as client-go waits its `RetryPeriod`.
 */
class AutoRequeue implements Requeue {
  readonly #backoff: Backoff;
  readonly #clock: Clock;
  readonly #election: string;
  #failedCampaigns = 0;

  constructor(
    { backoff, clock }: { backoff: Backoff; clock: Clock },
    election: string,
  ) {
    this.#backoff = backoff;
    this.#clock = clock;
    this.#election = election;
  }

  afterTerm(): Queued {
    this.#failedCampaigns = 0;
    return QUEUED;
  }

  async afterFailedCampaign(
    failure: unknown,
    stop: AbortSignal,
  ): Promise<void> {
    process.emitWarning(
      new LeaderSelectorWarning(failure, { election: this.#election }),
    );
    await delay(this.#backoff.duration(this.#failedCampaigns++), {
      clock: this.#clock,
      signal: stop,
    });
  }
}

/** A round is queued or runs, and its task does not run: it campaigns, resigns, or backs off. */
class Queued {}

const QUEUED = new Queued();

/** The task runs, and `interrupt` aborts its signal. */
class Leading {
  readonly interrupt: AbortController;

  constructor(interrupt: AbortController) {
    this.interrupt = interrupt;
  }
}

/** A round ended without autoRequeue: the selector waits for `requeue()`, which opens `requeued`. */
class Idle {
  readonly requeued = new Latch();
}

/** The rounds ended, by the dispose or by a failure: the selector leads no more. */
class Ended {}

const ENDED = new Ended();
