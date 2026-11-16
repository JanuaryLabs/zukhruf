import PQueue from 'p-queue';

import { type Clock, untilAborted } from '@zukhruf/async';

import type { Eviction } from './eviction.ts';
import type { PoolStats } from './pool-stats.ts';
import type { Sizing } from './sizing.ts';
import { Slots } from './slots.ts';
import type { Startup } from './startup.ts';
import type { Worker } from './worker.ts';

// Lends workers to jobs, one job per worker at a time. The sizing decides how
// many workers run, the startup when they start, and the eviction when an
// idle worker closes. A job takes an idle worker first. A worker that exits is
// replaced when a job next needs its slot, or sooner when the startup is
// eager and the worker was idle: at once when it ran 10 minutes, after a
// back-off when it exited early or its warm-up failed. The owner disposes the
// pool, which stops every worker.
export class Pool<T extends Worker<never, unknown>> implements AsyncDisposable {
  readonly #queue: PQueue;
  readonly #slots: Slots<T>;
  readonly #clock: Clock;

  constructor(options: {
    size: Sizing;
    startup: Startup;
    eviction: Eviction;
    create: () => T;
    /** The clock of every time that the pool measures and waits: `globalThis` in production, a fake clock in a test. */
    clock: Clock;
  }) {
    this.#clock = options.clock;
    this.#queue = new PQueue({ concurrency: options.size.current });
    this.#slots = new Slots({
      ...options,
      resized: (current) => {
        this.#queue.concurrency = current;
      },
    });
  }

  // Settles when the workers the startup starts with the pool are ready, and
  // rejects when one of them fails to start.
  ready(): Promise<void> {
    return this.#slots.ready();
  }

  get stats(): PoolStats {
    return this.#slots.stats(this.#queue.size);
  }

  // A job aborted while it runs kills its worker. A job aborted while its
  // worker warms up leaves the warm-up running for the jobs after it.
  use<R>(job: (worker: T) => Promise<R>, signal?: AbortSignal): Promise<R> {
    const stop =
      signal === undefined
        ? this.#slots.stopped
        : AbortSignal.any([this.#slots.stopped, signal]);
    if (stop.aborted) return Promise.reject(stop.reason);
    // The queue does not take the signal: on abort it would free the slot
    // while the job still holds its worker.
    return this.#queue.add(async () => {
      stop.throwIfAborted();
      const slot = this.#slots.lend();
      try {
        const worker = await untilAborted(this.#slots.borrow(slot), stop);
        const kill = () => this.#slots.kill(slot, worker);
        stop.addEventListener('abort', kill, { once: true });
        const started = this.#clock.performance.now();
        try {
          const result = await job(worker);
          stop.throwIfAborted();
          return result;
        } catch (error) {
          stop.throwIfAborted();
          throw error;
        } finally {
          stop.removeEventListener('abort', kill);
          if (!stop.aborted) this.#slots.record(started, this.#queue.size > 0);
        }
      } finally {
        this.#slots.release(slot);
      }
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.#slots[Symbol.asyncDispose]();
    await this.#queue.onIdle();
  }
}
