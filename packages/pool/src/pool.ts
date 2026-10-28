import PQueue from 'p-queue';

import { Latch, untilAborted } from '@zukhruf/async';

import type { PoolStats } from './pool-stats.ts';
import type { Sizing } from './sizing.ts';
import type { Startup } from './startup.ts';
import type { Worker } from './worker.ts';

// The back-off before an eager pool replaces a worker that exited early, as
// Kubernetes restarts a container in CrashLoopBackOff (tuned by KEP-4603):
// 1 s, doubled for each early exit in a row, up to 60 s. A worker that ran
// 10 minutes ends the back-off.
const backoff = { first: 1_000, most: 60_000, reset: 600_000 };

// What a slot holds: nothing, a worker that starts, a worker that is ready
// since a time, a worker that ended and waits to be closed, or a back-off
// before its next worker starts.
type State<T> =
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'starting';
      readonly outcome: Latch<PromiseSettledResult<T>>;
    }
  | { readonly kind: 'ready'; readonly worker: T; readonly since: number }
  | { readonly kind: 'lost'; readonly worker: T; readonly since: number }
  | { readonly kind: 'backoff'; readonly timer: NodeJS.Timeout };

interface Slot<T> {
  readonly index: number;
  state: State<T>;
  // Workers in a row that exited before they ran 10 minutes.
  early: number;
}

// Lends workers to jobs, one job per worker at a time. The sizing decides how
// many workers run and the startup when they start. A worker that exits is
// replaced when a job next needs its slot, or sooner when the startup is
// eager and the worker was idle: at once when it ran 10 minutes, after a
// back-off when it exited early. The owner disposes the pool, which stops
// every worker.
export class Pool<T extends Worker> implements AsyncDisposable {
  readonly #create: () => T;
  readonly #startup: Startup;
  readonly #sizing: Sizing;
  readonly #queue: PQueue;
  readonly #slots: Slot<T>[];
  readonly #lent = new Set<Slot<T>>();
  readonly #workers = new Set<T>();
  readonly #stopped = new AbortController();
  readonly #started = new Latch<PromiseSettledResult<void>>();
  // When the pool last changed how many workers it runs.
  #resized = performance.now();

  constructor(options: { size: Sizing; startup: Startup; create: () => T }) {
    this.#create = options.create;
    this.#startup = options.startup;
    this.#sizing = options.size;
    this.#queue = new PQueue({ concurrency: this.#sizing.current });
    this.#slots = Array.from({ length: this.#sizing.ceiling }, (_, index) => ({
      index,
      state: { kind: 'empty' },
      early: 0,
    }));
    const outcomes = options.startup.eager
      ? this.#running().map((slot) => this.#spawn(slot))
      : [];
    Promise.all(outcomes.map((outcome) => settled(outcome))).then(
      () => this.#started.open({ status: 'fulfilled', value: undefined }),
      (reason: unknown) => this.#started.open({ status: 'rejected', reason }),
    );
  }

  // Settles when the workers the startup starts with the pool are ready, and
  // rejects when one of them fails to start.
  async ready(): Promise<void> {
    const outcome = await this.#started.wait();
    if (outcome.status === 'rejected') throw outcome.reason;
  }

  get stats(): PoolStats {
    const stats = { starting: 0, idle: 0, lent: 0, waiting: this.#queue.size };
    for (const slot of this.#slots) {
      const lent = this.#lent.has(slot);
      if (slot.state.kind === 'starting') {
        stats.starting++;
        if (lent) stats.waiting++;
      } else if (slot.state.kind === 'ready') {
        if (lent) stats.lent++;
        else stats.idle++;
      }
    }
    return stats;
  }

  // A job aborted while it runs kills its worker. A job aborted while its
  // worker warms up leaves the warm-up running for the jobs after it.
  use<R>(job: (worker: T) => Promise<R>, signal?: AbortSignal): Promise<R> {
    const stop =
      signal === undefined
        ? this.#stopped.signal
        : AbortSignal.any([this.#stopped.signal, signal]);
    if (stop.aborted) return Promise.reject(stop.reason);
    // The queue does not take the signal: on abort it would free the slot
    // while the job still holds its worker.
    return this.#queue.add(async () => {
      stop.throwIfAborted();
      const slot = this.#running().find((free) => !this.#lent.has(free))!;
      this.#lent.add(slot);
      try {
        const worker = await untilAborted(this.#borrow(slot), stop);
        const kill = () => {
          worker.kill();
          this.#lose(slot, worker);
        };
        stop.addEventListener('abort', kill, { once: true });
        const started = performance.now();
        try {
          const result = await job(worker);
          stop.throwIfAborted();
          return result;
        } catch (error) {
          stop.throwIfAborted();
          throw error;
        } finally {
          stop.removeEventListener('abort', kill);
          if (!stop.aborted) this.#record(started);
        }
      } finally {
        this.#lent.delete(slot);
        if (slot.index >= this.#sizing.kept) this.#retire(slot);
      }
    });
  }

  #running(): Slot<T>[] {
    return this.#slots.slice(0, this.#sizing.current);
  }

  async #borrow(slot: Slot<T>): Promise<T> {
    const state = slot.state;
    if (state.kind === 'ready') return state.worker;
    if (state.kind === 'lost') {
      slot.state = { kind: 'empty' };
      void this.#close(state.worker);
    }
    // A job does not wait out a back-off: its worker starts now.
    if (state.kind === 'backoff') clearTimeout(state.timer);
    const worker = await settled(
      state.kind === 'starting' ? state.outcome : this.#spawn(slot),
    );
    const now = slot.state;
    if (now.kind === 'ready' && now.worker === worker) return worker;
    // The worker exited between its start and this borrow.
    return this.#borrow(slot);
  }

  // A job measures how many workers pay only if, since it started, the pool
  // ran the same number of workers and each was ready, and another job waited
  // when it finished.
  #record(started: number): void {
    const steady = this.#steady();
    this.#sizing.record({
      started,
      finished: performance.now(),
      measurable:
        steady !== undefined && started >= steady && this.#queue.size > 0,
    });
    for (const slot of this.#slots.slice(this.#sizing.kept)) this.#retire(slot);
    if (this.#sizing.current === this.#queue.concurrency) return;
    this.#queue.concurrency = this.#sizing.current;
    this.#resized = performance.now();
    for (const slot of this.#running())
      if (slot.state.kind === 'empty') this.#spawn(slot);
  }

  // Since when every slot the pool runs has had a ready worker, if they have.
  #steady(): number | undefined {
    let since = this.#resized;
    for (const { state } of this.#running()) {
      if (state.kind !== 'ready') return undefined;
      since = Math.max(since, state.since);
    }
    return since;
  }

  #spawn(slot: Slot<T>): Latch<PromiseSettledResult<T>> {
    const outcome = new Latch<PromiseSettledResult<T>>();
    slot.state = { kind: 'starting', outcome };
    const turn = Promise.withResolvers<void>();
    this.#startup
      .turn(turn.promise)
      .then(async () => {
        this.#stopped.signal.throwIfAborted();
        const worker = this.#create();
        this.#workers.add(worker);
        try {
          await worker.ready?.();
          return worker;
        } catch (error) {
          worker.kill();
          await this.#close(worker);
          throw error;
        }
      })
      .then(
        (worker) => {
          if (slot.state.kind === 'starting' && slot.state.outcome === outcome)
            slot.state = { kind: 'ready', worker, since: performance.now() };
          outcome.open({ status: 'fulfilled', value: worker });
          turn.resolve();
          void worker.exited().then(() => this.#ended(slot, worker));
        },
        (reason: unknown) => {
          if (slot.state.kind === 'starting' && slot.state.outcome === outcome)
            slot.state = { kind: 'empty' };
          outcome.open({ status: 'rejected', reason });
          turn.resolve();
        },
      );
    return outcome;
  }

  // The pool killed the worker of a slot: no job may borrow it any more.
  #lose(slot: Slot<T>, worker: T): void {
    const state = slot.state;
    if (state.kind === 'ready' && state.worker === worker)
      slot.state = { kind: 'lost', worker, since: state.since };
  }

  #ended(slot: Slot<T>, worker: T): void {
    const state = slot.state;
    if (
      (state.kind !== 'ready' && state.kind !== 'lost') ||
      state.worker !== worker
    )
      return;
    slot.state = { kind: 'lost', worker, since: state.since };
    if (
      this.#lent.has(slot) ||
      this.#stopped.signal.aborted ||
      !this.#startup.eager
    )
      return;
    slot.state = { kind: 'empty' };
    void this.#close(worker);
    slot.early =
      performance.now() - state.since < backoff.reset ? slot.early + 1 : 0;
    if (slot.index >= this.#sizing.current) return;
    if (slot.early === 0) {
      this.#spawn(slot);
      return;
    }
    const delay = Math.min(backoff.first * 2 ** (slot.early - 1), backoff.most);
    slot.state = {
      kind: 'backoff',
      timer: setTimeout(() => {
        slot.state = { kind: 'empty' };
        if (slot.index < this.#sizing.current) this.#spawn(slot);
      }, delay),
    };
  }

  // Closes the worker of a slot the pool no longer keeps, once its job ends.
  #retire(slot: Slot<T>): void {
    if (this.#lent.has(slot)) return;
    const state = slot.state;
    slot.state = { kind: 'empty' };
    if (state.kind === 'ready' || state.kind === 'lost')
      void this.#close(state.worker);
    else if (state.kind === 'backoff') clearTimeout(state.timer);
    else if (state.kind === 'starting')
      void settled(state.outcome).then(
        (worker) => this.#close(worker),
        () => undefined,
      );
  }

  async #close(worker: T): Promise<void> {
    await worker.close();
    this.#workers.delete(worker);
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#stopped.abort();
    for (const { state } of this.#slots)
      if (state.kind === 'backoff') clearTimeout(state.timer);
    for (const worker of this.#workers) worker.kill();
    await Promise.all([...this.#workers].map((worker) => worker.close()));
    await this.#queue.onIdle();
  }
}

// The worker a creation gave, or its failure.
async function settled<T>(outcome: Latch<PromiseSettledResult<T>>): Promise<T> {
  const result = await outcome.wait();
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}
