import { Latch, type WallClock, delay } from '@zukhruf/async';
import { SqliteElection, type Term } from '@zukhruf/election';

import type { Eviction } from './eviction.ts';
import type { Sizing } from './sizing.ts';
import { type Slot, Slots } from './slots.ts';
import type { Startup } from './startup.ts';
import { Store, TOUCH_INTERVAL } from './store.ts';
import type { WorkerKind } from './worker-kind.ts';
import type { Worker } from './worker.ts';

// The read of the store that finds the jobs that no wake told of (ADR 0018).
const BACKSTOP = 1_000;

/** A job's data in the store: the pool's envelope around the input (ADR 0012). */
interface Envelope<Input> {
  readonly input: Input;
}

/** The end of one run of a job on a worker. */
type Outcome<Output> =
  | { readonly output: Output }
  | { readonly failure: unknown }
  // The kind's time limit ended first.
  | { readonly expired: true }
  // A touch did not find the job under the owner's claim: the store took it
  // back, for example by a cancel or by a heartbeat that lapsed.
  | { readonly gone: true };

/**
 * Offers this host's workers of one kind, and owns them while this host
 * leads the election of the kind's store (ADR 0013). A standby starts no
 * worker (ADR 0023). The owner takes as many jobs from the queue of its
 * revision as it has free workers, runs each on a worker, and settles it with
 * complete or fail (ADR 0017), so its sizing caps the jobs of its computer
 * (ADR 0016). While a job runs, the owner touches it every 5 s, and kills its
 * worker when the store took the job back or the kind's time limit ends. The
 * disposal is a hand-over: it stops fetching, waits for the running jobs,
 * resigns, and then closes the workers (ADR 0023).
 */
export class PoolWorkers<Input, Output> implements AsyncDisposable {
  readonly #kind: WorkerKind<Input, Output>;
  readonly #clock: WallClock;
  readonly #create: () => Worker<Input, Output>;
  readonly #size: Sizing;
  readonly #startup: Startup;
  readonly #eviction: Eviction;
  readonly #store: Store;
  readonly #election: SqliteElection;
  readonly #disposed = new AbortController();
  // Aborts with the first failure of the store: the host then stops owning.
  readonly #failed = new AbortController();
  // Opens when the host stops offering its workers, with the failure that
  // stopped it, if one did.
  readonly #ended = new Latch<PromiseSettledResult<void>>();

  constructor(options: {
    kind: WorkerKind<Input, Output>;
    /** The path of the store's SQLite file, such as `computerStore(process.env)` (ADR 0015). */
    store: string;
    /** The clock of every time that the pool measures and waits: `globalThis` in production. */
    clock: WallClock;
    create: () => Worker<Input, Output>;
    size: Sizing;
    startup: Startup;
    eviction: Eviction;
  }) {
    this.#kind = options.kind;
    this.#clock = options.clock;
    this.#create = options.create;
    this.#size = options.size;
    this.#startup = options.startup;
    this.#eviction = options.eviction;
    this.#store = new Store(options.store, options.clock);
    const fail = (error: unknown) => this.#failed.abort(error);
    this.#store.queue.on('error', fail);
    this.#store.notifications.on('error', fail);
    this.#election = new SqliteElection({
      directory: this.#store.folder,
      claimFile: `${options.kind.name}.claim`,
      epochFile: `${options.kind.name}.epoch`,
      clock: options.clock,
    });
    this.#live().then(
      () => this.#ended.open({ status: 'fulfilled', value: undefined }),
      (reason: unknown) => this.#ended.open({ status: 'rejected', reason }),
    );
  }

  async #live(): Promise<void> {
    const stop = AbortSignal.any([this.#disposed.signal, this.#failed.signal]);
    try {
      await this.#store.start(this.#kind);
      while (!stop.aborted) {
        const term = await this.#election.campaign({
          timeout: Infinity,
          signal: stop,
        });
        // A campaign with no time limit resolves only with a term.
        await this.#own(term!, stop);
      }
    } catch (error) {
      if (error !== this.#disposed.signal.reason) throw error;
    }
    this.#failed.signal.throwIfAborted();
  }

  // Owns until the stop, or until the term is lost: then it campaigns again.
  async #own(term: Term, stop: AbortSignal): Promise<void> {
    const owning = AbortSignal.any([stop, term.signal]);
    const running = new Set<Promise<void>>();
    let wake = Promise.withResolvers<void>();
    const slots = new Slots<Worker<Input, Output>>({
      size: this.#size,
      startup: this.#startup,
      eviction: this.#eviction,
      create: this.#create,
      clock: this.#clock,
      resized: () => wake.resolve(),
    });
    // Whether the last fetch took every job it asked for, so more may wait.
    let backlog = false;
    try {
      while (!owning.aborted) {
        const free = this.#size.current - running.size;
        if (free > 0) {
          const jobs = await this.#store.queue.fetch(this.#kind.queue, {
            batchSize: free,
          });
          backlog = jobs.length === free;
          for (const job of jobs) {
            const run = this.#run(slots, job, () => backlog)
              .catch((error: unknown) => this.#failed.abort(error))
              .finally(() => {
                running.delete(run);
                wake.resolve();
              });
            running.add(run);
          }
        }
        await this.#rest(wake.promise, owning);
        wake = Promise.withResolvers<void>();
      }
    } finally {
      await Promise.all(running);
      // A standby takes over before the workers close: a close can be slow.
      await term.resign();
      await slots[Symbol.asyncDispose]();
    }
  }

  // Waits for the backstop, a wake, or the end of the ownership.
  async #rest(wake: Promise<void>, owning: AbortSignal): Promise<void> {
    const woken = new AbortController();
    void wake.then(() => woken.abort());
    const signal = AbortSignal.any([owning, woken.signal]);
    await delay(BACKSTOP, { clock: this.#clock, signal }).catch(
      (error: unknown) => {
        if (!signal.aborted) throw error;
      },
    );
  }

  // Runs one fetched job on a worker, and settles it by its attempt. A
  // worker that fails to start fails the job, as the worker's own failure.
  // The kind's time limit and the touches start at the fetch, as the store
  // counts both from it, so a warm start counts too. At the time limit the
  // owner kills the worker and fails the job; when the store took the job
  // back, it kills the worker and settles nothing.
  async #run(
    slots: Slots<Worker<Input, Output>>,
    job: { id: string; retryCount: number; data: unknown },
    backlog: () => boolean,
  ): Promise<void> {
    const attempt = { id: job.id, retryCount: job.retryCount };
    const slot = slots.lend();
    const ended = new AbortController();
    try {
      const outcome = await Promise.race([
        this.#work(slots, slot, job.data, backlog, ended.signal),
        this.#watch(attempt, ended.signal),
      ]);
      ended.abort();
      // A settle that affects no row finds the job under another claim: the
      // store fenced it, and the output is dropped (ADR 0017).
      if ('output' in outcome)
        await this.#store.queue.complete(this.#kind.queue, attempt, {
          output: outcome.output,
        });
      else if ('failure' in outcome)
        await this.#store.queue.fail(
          this.#kind.queue,
          attempt,
          failure(outcome.failure),
        );
      else if ('expired' in outcome)
        await this.#store.queue.fail(
          this.#kind.queue,
          attempt,
          // The error of pg-boss's work at the time limit (manager.js:606).
          failure(
            new Error(
              `handler execution exceeded ${this.#kind.expireInSeconds}s`,
            ),
          ),
        );
    } finally {
      ended.abort();
      slots.release(slot);
    }
  }

  // Runs the input on the worker of the slot. The end of the run kills the
  // worker of a run that has not ended, and leaves its outcome unread.
  async #work(
    slots: Slots<Worker<Input, Output>>,
    slot: Slot<Worker<Input, Output>>,
    data: unknown,
    backlog: () => boolean,
    ended: AbortSignal,
  ): Promise<Outcome<Output>> {
    let worker: Worker<Input, Output>;
    try {
      worker = await slots.borrow(slot);
    } catch (error) {
      return { failure: error };
    }
    if (ended.aborted) return { gone: true };
    const kill = () => slots.kill(slot, worker);
    ended.addEventListener('abort', kill, { once: true });
    const started = this.#clock.performance.now();
    try {
      if (!isEnvelope<Input>(data))
        throw new TypeError('The job has no input: no Pool sent it.');
      return { output: await worker.run(data.input) };
    } catch (error) {
      return { failure: error };
    } finally {
      ended.removeEventListener('abort', kill);
      if (!ended.aborted) slots.record(started, backlog());
    }
  }

  // Touches the job every 5 s until the run ends, and resolves when the
  // kind's time limit ends or a touch finds that the store took the job back.
  async #watch(
    attempt: { id: string; retryCount: number },
    ended: AbortSignal,
  ): Promise<Outcome<Output>> {
    const deadline =
      this.#clock.performance.now() + this.#kind.expireInSeconds * 1_000;
    for (;;) {
      const left = deadline - this.#clock.performance.now();
      if (left <= 0) return { expired: true };
      await delay(Math.min(TOUCH_INTERVAL, left), {
        clock: this.#clock,
        signal: ended,
      });
      if (this.#clock.performance.now() >= deadline) return { expired: true };
      const { affected } = await this.#store.queue.touch(
        this.#kind.queue,
        attempt,
      );
      if (affected === 0) return { gone: true };
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#disposed.abort();
    const ended = await this.#ended.wait();
    await this.#store[Symbol.asyncDispose]();
    if (ended.status === 'rejected') throw ended.reason;
  }
}

// The pool does not check the input itself: a sender and an owner of one
// revision run the same code (ADR 0014).
function isEnvelope<Input>(data: unknown): data is Envelope<Input> {
  return typeof data === 'object' && data !== null && 'input' in data;
}

/** A failure as data: its name and its message (ADR 0019). */
function failure(error: unknown): { name: string; message: string } {
  return Error.isError(error)
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) };
}
