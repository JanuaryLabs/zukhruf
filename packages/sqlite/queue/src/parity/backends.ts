import { DatabaseSync } from 'node:sqlite';

import { PGlite } from '@electric-sql/pglite';
import {
  type MaintenanceOptions,
  PgBoss,
  type SchedulingOptions,
  TestClock,
  type Warning,
  type WipData,
  fromPglite,
} from 'pg-boss';

import type { JobQueue } from '../index.ts';
import { SqliteJobQueue } from '../index.ts';

export type WipWorker = Omit<WipData, 'options' | 'lastError'> & {
  options: Record<string, unknown>;
  lastError: { name: string; message: string } | null;
};

// The supervisor's and timekeeper's constructor options a scenario may set on
// both backends; every other scenario runs with supervise: false and
// schedule: false.
export type RunOptions = Pick<
  MaintenanceOptions,
  | 'supervise'
  | 'superviseIntervalSeconds'
  | 'monitorIntervalSeconds'
  | 'maintenanceIntervalSeconds'
  | 'queueCacheIntervalSeconds'
  | 'warningQueueSize'
> &
  Pick<
    SchedulingOptions,
    'schedule' | 'cronMonitorIntervalSeconds' | 'cronWorkerIntervalSeconds'
  >;

// A warning event at its clock time. pinSeconds is how long the stats
// aggregate held its snapshot in real time (node_modules/pg-boss/dist/
// plans.js:3478, 3552), so it is compared only as a finite count of seconds.
export type WarningEvent = {
  at: number;
  message: string;
  data: Record<string, unknown>;
};

// A wip event as both backends can be compared on: when it fired and each
// worker it listed, with worker ids aliased in order of first appearance
// (w1, w2, …), times in ms since the clock's start, and an error reduced to
// its name and message.
export type WipEvent = { at: number; workers: WipWorker[] };

// The wip, warning and stopped events of one run, normalized as they are
// emitted: a wip payload holds the worker's live options and error.
class RunEvents {
  readonly wip: WipEvent[] = [];
  readonly warnings: WarningEvent[] = [];
  // When each stopped event fired, in ms since the clock's start.
  readonly stopped: number[] = [];
  readonly #clock: TestClock;
  readonly #origin = Date.parse(ParityRun.start);
  readonly #aliases = new Map<string, string>();

  constructor(clock: TestClock) {
    this.#clock = clock;
  }

  onWip = (workers: WipData[]) => {
    this.wip.push({
      at: this.#clock.now() - this.#origin,
      workers: workers.map((worker) => this.#worker(worker)),
    });
  };

  onWarning = ({ message, data }: Warning) => {
    const fields: Record<string, unknown> = { ...data };
    if ('pinSeconds' in fields) {
      const seconds = fields.pinSeconds;
      fields.pinSeconds =
        typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0;
    }
    this.warnings.push({
      at: this.#clock.now() - this.#origin,
      message,
      data: fields,
    });
  };

  onStopped = () => {
    this.stopped.push(this.#clock.now() - this.#origin);
  };

  #worker(worker: WipData): WipWorker {
    const since = (ms: number | null) =>
      ms === null ? null : ms - this.#origin;
    return {
      ...worker,
      id: this.#alias(worker.id),
      workId: this.#alias(worker.workId),
      options: { ...worker.options },
      createdOn: worker.createdOn - this.#origin,
      lastFetchedOn: since(worker.lastFetchedOn),
      lastJobStartedOn: since(worker.lastJobStartedOn),
      lastJobEndedOn: since(worker.lastJobEndedOn),
      lastErrorOn: since(worker.lastErrorOn),
      lastError: this.#error(worker.lastError),
    };
  }

  #alias(id: string): string {
    const alias = this.#aliases.get(id) ?? `w${this.#aliases.size + 1}`;
    this.#aliases.set(id, alias);
    return alias;
  }

  #error(error: object | null) {
    if (error === null) {
      return null;
    }
    let message = 'message' in error ? String(error.message) : '';
    for (const [id, alias] of this.#aliases) {
      message = message.replaceAll(id, alias);
    }
    return { name: 'name' in error ? String(error.name) : '', message };
  }
}

// One queue on one backend, not yet started: each scenario calls start()
// itself, so lifecycle scenarios can act before it. Error events land in
// `errors`; an `error` emit with no listener would throw.
export class ParityRun {
  readonly queue: JobQueue;
  readonly errors: Error[];
  readonly wip: WipEvent[];
  readonly warnings: WarningEvent[];
  readonly stopped: number[];
  // One pg-boss TestClock per run drives both backends, so timestamps compare
  // exactly and each fires its timers (polls included) only on tick().
  readonly clock: TestClock;
  // Which backend this is, and SQL run on its own database as its caller
  // holds it: PGlite under pg-boss, the DatabaseSync under SQLite.
  readonly backend: string;
  readonly sql: (text: string) => Promise<void>;
  // The rows one query answers, for state no public method reads back.
  readonly rows: (text: string) => Promise<Record<string, unknown>[]>;
  readonly #close: () => Promise<void>;

  constructor(
    queue: JobQueue,
    errors: Error[],
    events: RunEvents,
    clock: TestClock,
    database: {
      backend: string;
      sql: (text: string) => Promise<void>;
      rows: (text: string) => Promise<Record<string, unknown>[]>;
    },
    close: () => Promise<void>,
  ) {
    this.queue = queue;
    this.backend = database.backend;
    this.sql = database.sql;
    this.rows = database.rows;
    this.errors = errors;
    this.wip = events.wip;
    this.warnings = events.warnings;
    this.stopped = events.stopped;
    this.clock = clock;
    this.#close = close;
  }

  static readonly start = '2026-01-01T00:00:00.000Z';

  close(): Promise<void> {
    return this.#close();
  }
}

// The oracle: real pg-boss on an in-memory PGlite, which pg-boss runs its own
// suite against (node_modules/pg-boss/package.json `test:pglite`).
export class PgBossBackend {
  readonly name = 'pg-boss';

  async open(options: RunOptions = {}): Promise<ParityRun> {
    const pglite = new PGlite();
    const errors: Error[] = [];
    const clock = new TestClock(ParityRun.start);
    const events = new RunEvents(clock);
    const boss = new PgBoss({
      backend: 'pglite',
      db: fromPglite(pglite),
      clock,
      schedule: false,
      supervise: false,
      useListenNotify: true,
      ...options,
    });
    boss.on('error', (error) => errors.push(error));
    boss.on('wip', events.onWip);
    boss.on('warning', events.onWarning);
    boss.on('stopped', events.onStopped);
    const sql = async (text: string) => {
      await pglite.exec(text);
    };
    const rows = async (text: string) =>
      (await pglite.query<Record<string, unknown>>(text)).rows;
    const database = { backend: this.name, sql, rows };
    return new ParityRun(boss, errors, events, clock, database, async () => {
      try {
        await boss.stop({ graceful: false, close: true });
      } finally {
        await pglite.close();
      }
    });
  }
}

export class SqliteBackend {
  readonly name = 'sqlite';

  async open(options: RunOptions = {}): Promise<ParityRun> {
    // The caller supplies the database, as the oracle's caller supplies
    // PGlite, and closes it after the queue stops.
    const database = new DatabaseSync(':memory:');
    const errors: Error[] = [];
    const clock = new TestClock(ParityRun.start);
    const events = new RunEvents(clock);
    const queue = new SqliteJobQueue({
      database,
      schedule: false,
      supervise: false,
      clock,
      useListenNotify: true,
      ...options,
    });
    queue.on('error', (error) => errors.push(error));
    queue.on('wip', events.onWip);
    queue.on('warning', events.onWarning);
    queue.on('stopped', events.onStopped);
    const sql = async (text: string) => {
      database.exec(text);
    };
    const rows = async (text: string) => database.prepare(text).all();
    const handle = { backend: this.name, sql, rows };
    return new ParityRun(queue, errors, events, clock, handle, async () => {
      try {
        await queue.stop({ graceful: false, close: true });
      } finally {
        database.close();
      }
    });
  }
}
