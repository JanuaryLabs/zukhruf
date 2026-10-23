import type { Clock, WipData, WorkOptions, WorkerState } from 'pg-boss';

import { Latch } from '@zukhruf/async';

import { Timers } from './timers.ts';

// work()'s options as checkWorkArgs copies them, with the poll intervals it
// adds in ms (node_modules/pg-boss/dist/attorney.js:367-368, 585-602).
export type WorkerOptions = WorkOptions & {
  pollingInterval: number;
  notifyPollingInterval: number;
};

export interface WorkerConfig<TJob> {
  id: string;
  workId: string;
  name: string;
  options: WorkerOptions;
  clock: Clock;
  resolveInterval: (lastFetchCount: number) => number;
  fetch: () => Promise<TJob[]>;
  onFetch: (jobs: TJob[]) => Promise<void>;
  onError: (error: Error) => void;
}

// One polling loop of a work() call, which starts one per localConcurrency
// (node_modules/pg-boss/dist/worker.js:53-114): fetch at once, hand the jobs
// over, then wait out the interval on the clock unless notified meanwhile.
export class Worker<TJob> {
  readonly id: string;
  // The id work() returned, shared by every loop it started.
  readonly workId: string;
  readonly name: string;
  readonly options: WorkerOptions;
  readonly createdOn: number;
  // The batch in flight, which a shutdown fails (manager.js:884-909).
  jobs: TJob[] = [];
  // The batch's controller while it runs, which a shutdown aborts.
  abortController: AbortController | null = null;
  readonly #clock: Clock;
  readonly #resolveInterval: (lastFetchCount: number) => number;
  readonly #fetch: () => Promise<TJob[]>;
  readonly #onFetch: (jobs: TJob[]) => Promise<void>;
  readonly #onError: (error: Error) => void;
  #state: WorkerState = 'created';
  // pg-boss's #beenNotified, cleared as each round starts: notify() counts,
  // and a round was notified when the count moved since it started.
  #notifications = 0;
  // Aborts the round's wait; a fresh one arms each wait.
  #wake = new AbortController();
  // How the loop ended, which stop() waits for.
  readonly #ran = new Latch<{ ok: true } | { ok: false; error: unknown }>();
  #lastFetchedOn: number | null = null;
  #lastJobStartedOn: number | null = null;
  #lastJobEndedOn: number | null = null;
  #lastJobDuration: number | null = null;
  #lastError: Error | null = null;
  #lastErrorOn: number | null = null;

  constructor(config: WorkerConfig<TJob>) {
    this.id = config.id;
    this.workId = config.workId;
    this.name = config.name;
    this.options = config.options;
    this.#clock = config.clock;
    this.createdOn = config.clock.now();
    this.#resolveInterval = config.resolveInterval;
    this.#fetch = config.fetch;
    this.#onFetch = config.onFetch;
    this.#onError = config.onError;
  }

  get stopping(): boolean {
    return this.#state === 'stopping';
  }

  get stopped(): boolean {
    return this.#state === 'stopped';
  }

  // pg-boss keeps the loop's promise for stop() to await (worker.js:51, 113):
  // a loop that rejects, for example on an error emit with no listener,
  // rejects the stop that waits for it, and is unhandled when no stop waits.
  start(): void {
    void this.#run().then(
      () => this.#ran.open({ ok: true }),
      (error: unknown) => {
        this.#ran.open({ ok: false, error });
        if (!this.stopping) {
          throw error;
        }
      },
    );
  }

  async #run(): Promise<void> {
    // A stop() before start() leaves the loop at once.
    if (this.#state === 'created') {
      this.#state = 'active';
    }
    while (!this.stopping) {
      const started = this.#clock.now();
      // Stays 0 on an error, so a failed fetch backs off to the normal poll.
      let fetchedCount = 0;
      const notifications = this.#notifications;
      try {
        const jobs = await this.#fetch();
        this.#lastFetchedOn = this.#clock.now();
        fetchedCount = jobs.length;
        this.jobs = jobs;
        this.#lastJobStartedOn = this.#lastFetchedOn;
        await this.#onFetch(jobs);
        this.#lastJobEndedOn = this.#clock.now();
        this.jobs = [];
      } catch (caught) {
        this.#lastErrorOn = this.#clock.now();
        const error =
          caught instanceof Error ? caught : new Error(String(caught));
        this.#lastError = error;
        error.message = `${error.message} (Queue: ${this.name}, Worker: ${this.id})`;
        this.#onError(error);
      }
      const duration = this.#clock.now() - started;
      this.#lastJobDuration = duration;
      const remaining = this.#resolveInterval(fetchedCount) - duration;
      if (
        !this.stopping &&
        this.#notifications === notifications &&
        remaining > 100
      ) {
        this.#wake = new AbortController();
        await Timers.delay(this.#clock, remaining, undefined, this.#wake);
      }
    }
    this.#state = 'stopped';
  }

  notify(): void {
    this.#notifications += 1;
    this.#wake.abort();
  }

  // worker.js:115-122
  abort(): void {
    if (!this.abortController) {
      return;
    }
    if (!this.abortController.signal.aborted) {
      this.abortController.abort();
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.#state = 'stopping';
    this.#wake.abort();
    const ran = await this.#ran.wait();
    if (!ran.ok) {
      throw ran.error;
    }
  }

  // worker.js:123-139
  toWipData(): WipData {
    return {
      id: this.id,
      workId: this.workId,
      name: this.name,
      options: this.options,
      state: this.#state,
      count: this.jobs.length,
      createdOn: this.createdOn,
      lastFetchedOn: this.#lastFetchedOn,
      lastJobStartedOn: this.#lastJobStartedOn,
      lastJobEndedOn: this.#lastJobEndedOn,
      lastError: this.#lastError,
      lastErrorOn: this.#lastErrorOn,
      lastJobDuration: this.#lastJobDuration,
    };
  }
}
