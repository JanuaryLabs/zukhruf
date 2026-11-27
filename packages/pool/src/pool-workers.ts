import {
  Backoff,
  Future,
  WaitGroup,
  type WallClock,
  untilAborted,
} from '@zukhruf/async';
import { LeaderSelector, SqliteElection, type Term } from '@zukhruf/election';

import type { Eviction } from './eviction.ts';
import { Owner } from './owner.ts';
import type { PoolStats } from './pool-stats.ts';
import { PoolWarning } from './pool-warning.ts';
import type { Sizing } from './sizing.ts';
import type { Startup } from './startup.ts';
import { Store } from './store.ts';
import { type WorkerKind, newJobChannel } from './worker-kind.ts';
import type { Worker } from './worker.ts';

// client-go's RetryPeriod, which "core clients default ... to 2 seconds", with
// its JitterFactor of 1.2: each wait after a failed campaign is 2 s plus up to
// 1.2 times 2 s, so 2 s to 4.4 s (ADR 0024). That is 3.2 s ± 37.5 %.
const RETRY_PERIOD = 2_000;
const JITTER_FACTOR = 1.2;
const CAMPAIGN_RETRY = new Backoff({
  initial: RETRY_PERIOD * (1 + JITTER_FACTOR / 2),
  multiplier: 1,
  max: RETRY_PERIOD * (1 + JITTER_FACTOR / 2),
  jitter: { kind: 'ratio', ratio: JITTER_FACTOR / (2 + JITTER_FACTOR) },
});

/**
 * Offers this host's workers of one kind, and owns them while this host
 * leads the election of the kind's store (ADR 0013): a `LeaderSelector` runs
 * the owner with each term that the host wins, and campaigns again after it
 * (ADR 0024). A standby starts no worker (ADR 0023). The disposal is a
 * hand-over: the owner stops fetching, waits for the running jobs, resigns,
 * and then closes the workers (ADR 0023).
 */
export class PoolWorkers<Input, Output> implements AsyncDisposable {
  readonly #kind: WorkerKind<Input, Output>;
  readonly #clock: WallClock;
  readonly #store: Store;
  readonly #election: SqliteElection;
  readonly #owner: Owner<Input, Output>;
  readonly #disposed = new AbortController();
  // Aborts, with a DeprecatedRevisionError, once the store holds a newer
  // revision of the kind: the host then offers its workers no more (ADR 0022).
  readonly #deprecated = new AbortController();
  readonly #offering = AbortSignal.any([
    this.#disposed.signal,
    this.#deprecated.signal,
  ]);
  // The reads of the revisions that a wake started, which end before the
  // store closes.
  readonly #reads = new WaitGroup();
  // Settles when the host stops offering its workers, and fails with the
  // failure that stopped it, if one did.
  readonly #ended: Future<void>;
  // Settles at the first term, by the startup of its workers. A host that
  // stops offering its workers before that rejects it.
  readonly #ready = new Future<void>();

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
    this.#store = new Store(options.store, options.clock);
    this.#owner = new Owner({
      kind: options.kind,
      store: this.#store,
      clock: options.clock,
      create: options.create,
      size: options.size,
      startup: options.startup,
      eviction: options.eviction,
    });
    const { queue } = options.kind;
    this.#store.queue.on('error', (error) =>
      process.emitWarning(
        new PoolWarning(error, { code: 'ZUKHRUF_POOL_QUEUE_ERROR', queue }),
      ),
    );
    this.#store.notifications.on('error', (error) =>
      process.emitWarning(
        new PoolWarning(error, {
          code: 'ZUKHRUF_POOL_NOTIFICATIONS_ERROR',
          queue,
        }),
      ),
    );
    const newJob = newJobChannel(options.kind);
    this.#store.notifications.on('notification', ({ channel, payload }) => {
      if (channel !== newJob) return;
      // A wake only says "read the store", and the store decides whether a
      // newer revision took over (ADR 0022).
      if (Number(payload) > options.kind.revision) {
        const read = this.#reads.add();
        void this.#learn().finally(() => read[Symbol.dispose]());
      }
      this.#owner.hear();
    });
    this.#election = new SqliteElection({
      directory: this.#store.folder,
      claimFile: `${options.kind.name}.claim`,
      epochFile: `${options.kind.name}.epoch`,
      clock: options.clock,
    });
    this.#ended = Future.run(() => this.#live());
    this.#owner.ready().then(
      () => this.#ready.resolve(),
      (error: unknown) => this.#ready.reject(error),
    );
    this.#ended.wait().then(
      () => this.#ready.reject(this.#offering.reason),
      (error: unknown) => this.#ready.reject(error),
    );
  }

  /** This host's slots: zero in each count while it does not own (ADR 0013). */
  get stats(): PoolStats {
    return this.#owner.stats;
  }

  /**
   * Resolves when this host owns and the workers that its startup starts are
   * ready, and rejects when one of them fails to start (ADR 0013).
   */
  ready(): Promise<void> {
    return this.#ready.wait();
  }

  // Offers the workers until the disposal or the deprecation of its revision,
  // and then closes the store, so every disposal waits for the one end. A
  // store that fails to start ends the host with its failure.
  async #live(): Promise<void> {
    const offering = this.#offering;
    try {
      await this.#store.start(this.#kind);
      // Listens before its first fetch, so a job sent in between is not lost.
      await this.#store.notifications.listen(newJobChannel(this.#kind));
      // A host of a deprecated revision never campaigns (ADR 0022).
      await this.#learn();
      // It tells of its revision, so an older owner steps down and an older
      // standby ends its campaign with no job of this revision sent.
      this.#store.tell(newJobChannel(this.#kind), String(this.#kind.revision));
      await this.#lead(offering);
    } catch (error) {
      if (error !== offering.reason) throw error;
    } finally {
      await this.#reads.wait({ signal: undefined });
      await this.#store[Symbol.asyncDispose]();
    }
  }

  // Leads until the host stops offering its workers: then the dispose of the
  // selector ends the term that runs and starts no round after it.
  async #lead(offering: AbortSignal): Promise<void> {
    offering.throwIfAborted();
    await using selector = LeaderSelector.start(
      this.#election,
      { takeLeadership: (term, signal) => this.#own(term, signal) },
      { autoRequeue: { backoff: CAMPAIGN_RETRY, clock: this.#clock } },
    );
    // Waits until the host stops offering its workers, or a failure ended
    // the selector. Only the dispose rejects with that failure: a rejection
    // here too would wrap it in a SuppressedError.
    try {
      await untilAborted(Promise.allSettled([selector.ended]), offering);
    } catch (error) {
      if (error !== offering.reason) throw error;
    }
  }

  // A standby whose wake of a newer revision came after the owner resigned,
  // or was lost, learns of it before it starts a worker. The deprecation
  // reaches the owner at once, before the dispose of the selector does.
  async #own(term: Term, signal: AbortSignal): Promise<void> {
    await this.#learn();
    await this.#owner.takeLeadership(
      term,
      AbortSignal.any([signal, this.#offering]),
    );
  }

  // Deprecates this host for good once the store holds a newer revision of
  // the kind (ADR 0022). A read that fails is a warning, and the next turn or
  // wake reads again.
  async #learn(): Promise<void> {
    try {
      const deprecated = await this.#store.deprecation(this.#kind);
      if (deprecated !== undefined) this.#deprecated.abort(deprecated);
    } catch (error) {
      process.emitWarning(
        new PoolWarning(error, {
          code: 'ZUKHRUF_POOL_REVISIONS_READ_FAILED',
          queue: this.#kind.queue,
        }),
      );
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.#disposed.abort();
    await this.#ended.wait();
  }
}
