import PQueue from 'p-queue';

import { type Clock, Latch, delay, untilAborted } from '@zukhruf/async';

import type { Eviction } from './eviction.ts';
import type { PoolStats } from './pool-stats.ts';
import type { Sizing } from './sizing.ts';
import type { Startup } from './startup.ts';
import type { Worker } from './worker.ts';

// The back-off before an eager pool starts a worker again after an early
// exit, as Kubernetes restarts a container in CrashLoopBackOff (tuned by
// KEP-4603): 1 s, doubled for each early exit in a row, up to 60 s. A worker
// whose warm-up fails exits early too (ADR 0010). A worker that ran 10 minutes
// ends the back-off.
const backoff = { first: 1_000, most: 60_000, reset: 600_000 };

// What a slot holds: nothing, a worker that starts, a worker that is ready
// since a time, a worker that ended and waits to be closed, or a back-off
// before its next worker starts. A ready worker has the controller of its
// idle wait, and a back-off the controller of its wait: each wait is live
// while its controller is not aborted.
interface Ready<T> {
  readonly kind: 'ready';
  readonly worker: T;
  readonly since: number;
  readonly idle: AbortController;
}

type State<T> =
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'starting';
      readonly outcome: Latch<PromiseSettledResult<T>>;
    }
  | Ready<T>
  | { readonly kind: 'lost'; readonly worker: T; readonly since: number }
  | { readonly kind: 'backoff'; readonly wait: AbortController };

interface Slot<T> {
  readonly index: number;
  state: State<T>;
  // Workers in a row that exited before they ran 10 minutes.
  early: number;
}

// Lends workers to jobs, one job per worker at a time. The sizing decides how
// many workers run, the startup when they start, and the eviction when an
// idle worker closes. A job takes an idle worker first. A worker that exits is
// replaced when a job next needs its slot, or sooner when the startup is
// eager and the worker was idle: at once when it ran 10 minutes, after a
// back-off when it exited early or its warm-up failed. The owner disposes the
// pool, which stops every worker.
export class Pool<T extends Worker> implements AsyncDisposable {
  readonly #create: () => T;
  readonly #startup: Startup;
  readonly #sizing: Sizing;
  readonly #eviction: Eviction;
  readonly #queue: PQueue;
  readonly #slots: Slot<T>[];
  readonly #lent = new Set<Slot<T>>();
  readonly #workers = new Set<T>();
  readonly #stopped = new AbortController();
  readonly #started = new Latch<PromiseSettledResult<void>>();
  readonly #clock: Clock;
  // When the pool last changed how many workers it runs.
  #resized: number;

  constructor(options: {
    size: Sizing;
    startup: Startup;
    eviction: Eviction;
    create: () => T;
    /** The clock of every time that the pool measures and waits: `globalThis` in production, a fake clock in a test. */
    clock: Clock;
  }) {
    this.#clock = options.clock;
    this.#resized = this.#clock.performance.now();
    this.#create = options.create;
    this.#startup = options.startup;
    this.#sizing = options.size;
    this.#eviction = options.eviction;
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
      const slot = this.#pick();
      this.#lent.add(slot);
      // A job takes the worker before its eviction lets it go.
      if (slot.state.kind === 'ready') slot.state.idle.abort();
      try {
        const worker = await untilAborted(this.#borrow(slot), stop);
        const kill = () => {
          worker.kill();
          this.#lose(slot, worker);
        };
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
          if (!stop.aborted) this.#record(started);
        }
      } finally {
        this.#lent.delete(slot);
        const state = slot.state;
        if (slot.index >= this.#sizing.kept) this.#retire(slot);
        else if (state.kind === 'ready')
          this.#rest(slot, state.worker, state.since);
        else if (state.kind === 'lost')
          this.#replace(slot, state.worker, state.since);
      }
    });
  }

  #running(): Slot<T>[] {
    return this.#slots.slice(0, this.#sizing.current);
  }

  // The slot a job takes, the lowest of its kind: an idle worker, else a
  // worker that starts, else an empty slot or one whose worker ended, else a
  // back-off. Jobs stay on the low slots, so the high ones stay idle until
  // their eviction lets them go. This is the reason Commons Pool lends the
  // object returned last (POOL-86) and Go's database/sql reuses the connection
  // idle for the shortest time (sql.go:1336-1341).
  #pick(): Slot<T> {
    const free = this.#running().filter((slot) => !this.#lent.has(slot));
    return (
      free.find(({ state }) => state.kind === 'ready') ??
      free.find(({ state }) => state.kind === 'starting') ??
      free.find(
        ({ state }) => state.kind === 'empty' || state.kind === 'lost',
      ) ??
      free.find(({ state }) => state.kind === 'backoff')!
    );
  }

  async #borrow(slot: Slot<T>): Promise<T> {
    const state = slot.state;
    if (state.kind === 'ready') return state.worker;
    if (state.kind === 'lost') {
      this.#enter(slot, { kind: 'empty' });
      void this.#close(state.worker);
    }
    // A job does not wait out a back-off: its worker starts now, and the start
    // ends the wait of the back-off.
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
      finished: this.#clock.performance.now(),
      measurable:
        steady !== undefined && started >= steady && this.#queue.size > 0,
    });
    for (const slot of this.#slots.slice(this.#sizing.kept)) this.#retire(slot);
    if (this.#sizing.current === this.#queue.concurrency) return;
    this.#queue.concurrency = this.#sizing.current;
    this.#resized = this.#clock.performance.now();
    // An idle worker waits for its eviction only while the pool runs its slot.
    for (const slot of this.#slots.slice(0, this.#sizing.kept)) {
      const state = slot.state;
      if (
        state.kind === 'ready' &&
        !this.#lent.has(slot) &&
        state.idle.signal.aborted === slot.index < this.#sizing.current
      )
        this.#rest(slot, state.worker, state.since);
    }
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
    this.#enter(slot, { kind: 'starting', outcome });
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
            this.#rest(slot, worker, this.#clock.performance.now());
          outcome.open({ status: 'fulfilled', value: worker });
          turn.resolve();
          void worker.exited().then(() => this.#ended(slot, worker));
        },
        (reason: unknown) => {
          if (
            slot.state.kind === 'starting' &&
            slot.state.outcome === outcome
          ) {
            this.#enter(slot, { kind: 'empty' });
            // A failed warm-up is an early exit, whoever started the worker,
            // as HikariCP tries a failed create again (ADR 0010).
            if (this.#startup.eager && !this.#stopped.signal.aborted) {
              slot.early++;
              this.#restart(slot);
            }
          }
          outcome.open({ status: 'rejected', reason });
          turn.resolve();
        },
      );
    return outcome;
  }

  // Every change of a slot's state comes here, so a ready worker that leaves
  // its slot ends its idle wait, and a slot that leaves its back-off ends the
  // wait of the back-off.
  #enter(slot: Slot<T>, next: State<T>): void {
    const state = slot.state;
    if (state.kind === 'ready') state.idle.abort();
    else if (state.kind === 'backoff') state.wait.abort();
    slot.state = next;
  }

  // A worker becomes idle in a slot. Its eviction may let it go only while
  // no job has it and the pool runs its slot: a slot the sizing keeps but does
  // not run has the worker the sizing tries (ADR 0002).
  #rest(slot: Slot<T>, worker: T, since: number): void {
    const state: Ready<T> = {
      kind: 'ready',
      worker,
      since,
      idle: new AbortController(),
    };
    this.#enter(slot, state);
    if (this.#lent.has(slot) || slot.index >= this.#sizing.current) {
      state.idle.abort();
      return;
    }
    this.#eviction.idle(
      AbortSignal.any([state.idle.signal, this.#stopped.signal]),
      () => this.#evict(slot, state),
      this.#clock,
    );
  }

  // Closes an idle worker that its eviction let go. The slot is empty before
  // the worker closes, so its exit starts no back-off and no replacement. A
  // worker that ran 10 minutes ends the back-off, as at an exit.
  #evict(slot: Slot<T>, state: Ready<T>): void {
    if (
      slot.state !== state ||
      this.#lent.has(slot) ||
      slot.index >= this.#sizing.current ||
      this.#stopped.signal.aborted
    )
      return;
    if (this.#clock.performance.now() - state.since >= backoff.reset)
      slot.early = 0;
    this.#retire(slot);
  }

  // The pool killed the worker of a slot: no job may borrow it any more.
  #lose(slot: Slot<T>, worker: T): void {
    const state = slot.state;
    if (state.kind === 'ready' && state.worker === worker)
      this.#enter(slot, { kind: 'lost', worker, since: state.since });
  }

  #ended(slot: Slot<T>, worker: T): void {
    const state = slot.state;
    if (
      (state.kind !== 'ready' && state.kind !== 'lost') ||
      state.worker !== worker
    )
      return;
    this.#enter(slot, { kind: 'lost', worker, since: state.since });
    if (!this.#lent.has(slot)) this.#replace(slot, worker, state.since);
  }

  // An eager pool closes the worker of a lost slot that no job has, and
  // starts the next one.
  #replace(slot: Slot<T>, worker: T, since: number): void {
    if (this.#stopped.signal.aborted || !this.#startup.eager) return;
    this.#enter(slot, { kind: 'empty' });
    void this.#close(worker);
    slot.early =
      this.#clock.performance.now() - since < backoff.reset
        ? slot.early + 1
        : 0;
    this.#restart(slot);
  }

  // Starts the next worker of an empty slot that the pool runs: at once when
  // no early exit came before, else after the back-off. A job that takes the
  // slot, the sizing that stops keeping it, or the disposal ends the wait.
  #restart(slot: Slot<T>): void {
    if (slot.index >= this.#sizing.current) return;
    if (slot.early === 0) {
      this.#spawn(slot);
      return;
    }
    const state = { kind: 'backoff', wait: new AbortController() } as const;
    this.#enter(slot, state);
    delay(Math.min(backoff.first * 2 ** (slot.early - 1), backoff.most), {
      clock: this.#clock,
      signal: AbortSignal.any([state.wait.signal, this.#stopped.signal]),
    }).then(
      () => {
        if (slot.state !== state) return;
        this.#enter(slot, { kind: 'empty' });
        if (slot.index < this.#sizing.current) this.#spawn(slot);
      },
      () => undefined,
    );
  }

  // Closes the worker of a slot the pool no longer keeps, once its job ends.
  #retire(slot: Slot<T>): void {
    if (this.#lent.has(slot)) return;
    const state = slot.state;
    this.#enter(slot, { kind: 'empty' });
    if (state.kind === 'ready' || state.kind === 'lost')
      void this.#close(state.worker);
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
    // The stop also ends the wait of each back-off.
    this.#stopped.abort();
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
