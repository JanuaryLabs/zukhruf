import {
  BackgroundService,
  type Backoff,
  type Clock,
  Latch,
  delay,
  untilAborted,
} from '@zukhruf/async';
import type { LeaderElection, Term } from '@zukhruf/election';
import type { FencedLease } from '@zukhruf/fencing';
import type { Lease } from '@zukhruf/lease';

import { Key } from '../mutex/key.ts';
import {
  type LeaderSelectorSource,
  LeaderSelectorWarning,
} from './leader-selector-warning.ts';

export interface LeaderSelectorListener<L> {
  /** Return, or reject with `signal.reason`, to give the leadership up. */
  takeLeadership(lease: L, signal: AbortSignal): Promise<void>;
}

export interface LeaderSelectorOptions {
  /** Without it, the selector leads once and then waits for `requeue()`. */
  autoRequeue?: { backoff: Backoff; clock: Clock } | undefined;
}

/**
 * One wait for the leadership, the task while it leads, and the give-up after
 * the task. The source gives `task` the lease and the listener's call on it.
 */
type Lead = (
  task: (
    lease: Lease,
    takeLeadership: (signal: AbortSignal) => Promise<void>,
  ) => Promise<void>,
  stop: AbortSignal,
) => Promise<void>;

/** How a round ended, when it did not end the selector. */
type RoundEnd = { granted: true } | { granted: false; error: unknown };

/**
 * Runs a task each time this process leads, over a key of the mutex or over
 * a `LeaderElection`, and gives the leadership up when the task ends. With
 * `autoRequeue`, it waits for the leadership again, until its dispose. A copy
 * of Apache Curator's `LeaderSelector`.
 */
export class LeaderSelector implements AsyncDisposable {
  readonly #lead: Lead;
  /** The subject of a warning: the key or the election, by its name. */
  readonly #source: LeaderSelectorSource;
  readonly #autoRequeue: LeaderSelectorOptions['autoRequeue'];
  readonly #disposed = new AbortController();
  #state: Queued | Leading | Idle | Ended = QUEUED;
  readonly #rounds: BackgroundService;

  private constructor(
    lead: Lead,
    source: LeaderSelectorSource,
    { autoRequeue }: LeaderSelectorOptions,
  ) {
    this.#lead = lead;
    this.#source = source;
    this.#autoRequeue = autoRequeue;
    this.#rounds = BackgroundService.start((stop) => this.#run(stop));
  }

  /** Leads while this process holds `key`. The task gets the lease of each grant. */
  static start(
    key: Key<'always'>,
    listener: LeaderSelectorListener<FencedLease>,
    options?: LeaderSelectorOptions,
  ): LeaderSelector;
  /** Leads while this process holds a term of `election`. The task gets the term. */
  static start(
    election: LeaderElection<unknown>,
    listener: LeaderSelectorListener<Term>,
    options?: LeaderSelectorOptions,
  ): LeaderSelector;
  // Not callable: each overload pairs the source with the listener of its lease.
  static start(
    source: Key<'always'> | LeaderElection<unknown>,
    listener: LeaderSelectorListener<FencedLease> &
      LeaderSelectorListener<Term>,
    options: LeaderSelectorOptions = {},
  ): LeaderSelector {
    return source instanceof Key
      ? new LeaderSelector(
          LeaderSelector.#overKey(source, listener),
          { key: source.name },
          options,
        )
      : new LeaderSelector(
          LeaderSelector.#overElection(source, listener),
          { election: source.name },
          options,
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

  /** Aborts the selector, and waits until the task ended and the leadership was given up. */
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
    // The failed acquires since the last grant.
    let retries = 0;
    while (!stop.aborted) {
      const state = this.#state;
      if (state instanceof Idle)
        await untilAborted(state.requeued.wait(), stop);
      const end = await this.#round(stop);
      if (end.granted) {
        retries = 0;
        if (this.#autoRequeue === undefined) this.#state = new Idle();
        continue;
      }
      if (this.#autoRequeue === undefined) throw end.error;
      const { backoff, clock } = this.#autoRequeue;
      process.emitWarning(new LeaderSelectorWarning(end.error, this.#source));
      await delay(backoff.duration(retries++), { clock, signal: stop });
    }
  }

  /** Rejects with the failure of the task, or with `stop.reason` when the dispose stopped the wait. */
  async #round(stop: AbortSignal): Promise<RoundEnd> {
    let led: { lease: Lease; signal: AbortSignal } | undefined;
    try {
      await this.#lead(async (lease, takeLeadership) => {
        const interrupt = new AbortController();
        const signal = AbortSignal.any([stop, interrupt.signal, lease.signal]);
        led = { lease, signal };
        this.#state = new Leading(interrupt);
        try {
          await takeLeadership(signal);
        } finally {
          this.#state = QUEUED;
        }
      }, stop);
      return { granted: true };
    } catch (error) {
      if (led === undefined) {
        if (stop.aborted && error === stop.reason) throw error;
        return { granted: false, error };
      }
      // A task that ends after a loss has a loss, as in Mutex.acquire.
      if (led.lease.signal.aborted) return { granted: true };
      if (led.signal.aborted && error === led.signal.reason)
        return { granted: true };
      throw error;
    }
  }

  static #overKey(
    key: Key<'always'>,
    listener: LeaderSelectorListener<FencedLease>,
  ): Lead {
    return (task, stop) =>
      key.run(
        (lease) =>
          task(lease, (signal) => listener.takeLeadership(lease, signal)),
        { signal: stop },
      );
  }

  static #overElection(
    election: LeaderElection<unknown>,
    listener: LeaderSelectorListener<Term>,
  ): Lead {
    return async (task, stop) => {
      // A campaign with no time limit resolves only with a term.
      await using term = (await election.campaign({
        timeout: Infinity,
        signal: stop,
      }))!;
      await task(term, (signal) => listener.takeLeadership(term, signal));
    };
  }
}

/** A round is queued or runs, and its task does not run: it waits for the leadership, gives it up, or backs off. */
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
