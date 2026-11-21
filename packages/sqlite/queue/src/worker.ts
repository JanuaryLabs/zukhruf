import {
  type Clock,
  type WipData,
  type WorkOptions,
  type WorkerState,
  systemClock,
} from 'pg-boss';

import { Future } from '@zukhruf/async';

import { Timers } from './timers.ts';

// work()'s options as checkWorkArgs copies them, with the poll intervals it
// adds in ms (node_modules/pg-boss/dist/attorney.js:367-368, 638-655).
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

type Observed = Pick<
  WipData,
  | 'lastFetchedOn'
  | 'lastJobStartedOn'
  | 'lastJobEndedOn'
  | 'lastJobDuration'
  | 'lastError'
  | 'lastErrorOn'
>;

// One polling loop of a work() call, which starts one per localConcurrency
// (node_modules/pg-boss/dist/worker.js:61-129): fetch at once, hand the jobs
// over, then wait out the interval on the clock unless notified meanwhile.
export class Worker<TJob> {
  readonly id: string;
  // The id work() returned, shared by every loop it started.
  readonly workId: string;
  readonly name: string;
  readonly options: WorkerOptions;
  readonly createdOn: number;
  // The batch in flight, which a shutdown fails (manager.js:1129-1159).
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
  // Aborted once stop() has spent its grace for running handlers, so a batch
  // that lands after it is refused (12.37.0, #953: manager.js:679-681,
  // 1131-1135).
  readonly #grace = new AbortController();
  // Aborted once stop() begins: a handler overrun waits only until then
  // (12.38.0: worker.js:121-128).
  readonly #stopRequested = new AbortController();
  // How the loop ended, which stop() waits for.
  readonly #ran = new Future<void>();
  // What the loop saw last, as pg-boss reports it in toWipData.
  #observed: Observed = {
    lastFetchedOn: null,
    lastJobStartedOn: null,
    lastJobEndedOn: null,
    lastJobDuration: null,
    lastError: null,
    lastErrorOn: null,
  };

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

  get stopSignal(): AbortSignal {
    return this.#stopRequested.signal;
  }

  get graceExpired(): boolean {
    return this.#grace.signal.aborted;
  }

  expireGrace(): void {
    this.#grace.abort();
  }

  // pg-boss keeps the loop's promise for stop() to await (worker.js:59, 125):
  // a loop that rejects, for example on an error emit with no listener,
  // rejects the stop that waits for it, and is unhandled when no stop waits.
  start(): void {
    void this.#run().then(
      () => this.#ran.resolve(),
      (error: unknown) => {
        this.#ran.reject(error);
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
      // The round runs on the system clock of pg-boss, not the configured
      // clock: a clock set back during the round would make the duration
      // negative and stretch the wait by that much. The job times below
      // read the configured clock (12.38.1, #990: worker.js:64-67,90).
      const started = systemClock.now();
      // Stays 0 on an error, so a failed fetch backs off to the normal poll.
      let fetchedCount = 0;
      const notifications = this.#notifications;
      try {
        const jobs = await this.#fetch();
        const fetchedOn = this.#clock.now();
        this.#observed = {
          ...this.#observed,
          lastFetchedOn: fetchedOn,
          lastJobStartedOn: fetchedOn,
        };
        fetchedCount = jobs.length;
        this.jobs = jobs;
        await this.#onFetch(jobs);
        this.#observed = {
          ...this.#observed,
          lastJobEndedOn: this.#clock.now(),
        };
        this.jobs = [];
      } catch (caught) {
        const erroredOn = this.#clock.now();
        const error = Error.isError(caught)
          ? caught
          : new Error(String(caught));
        this.#observed = {
          ...this.#observed,
          lastError: error,
          lastErrorOn: erroredOn,
        };
        error.message = `${error.message} (Queue: ${this.name}, Worker: ${this.id})`;
        this.#onError(error);
      }
      const duration = systemClock.now() - started;
      this.#observed = { ...this.#observed, lastJobDuration: duration };
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

  // worker.js:130-137
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
    this.#stopRequested.abort();
    this.#wake.abort();
    await this.#ran.wait();
  }

  // worker.js:138-154
  toWipData(): WipData {
    return {
      id: this.id,
      workId: this.workId,
      name: this.name,
      options: this.options,
      state: this.#state,
      count: this.jobs.length,
      createdOn: this.createdOn,
      ...this.#observed,
    };
  }
}
