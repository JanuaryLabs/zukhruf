import assert from 'node:assert';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import type { SQLInputValue } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';

import { CronExpressionParser } from 'cron-parser';
import {
  type Clock,
  type ClockTimer,
  type FindJobsOptions,
  type JobAttempt,
  type MaintenanceOptions,
  type OffWorkOptions,
  type PgBossEventMap,
  type Queue,
  type Request,
  type ScheduleOptions,
  type SendOptions,
  type StopOptions,
  type UpdateQueueOptions,
  type WipData,
  type WorkHandler,
  type WorkOptions,
  policies,
  scheduleKinds,
} from 'pg-boss';

import { Latch } from '@zukhruf/async';

import { Activity } from './activity.ts';
import { Attorney } from './attorney.ts';
import { DatabaseError } from './database-error.ts';
import { Database } from './database.ts';
import { InFlight } from './in-flight.ts';
import { JobFetcher } from './job-fetcher.ts';
import type { FoundJob, JobQueue } from './job-queue.ts';
import { JobRows } from './job-rows.ts';
import type { JobRow } from './job-rows.ts';
import { JobSettler } from './job-settler.ts';
import type { JobOutcome } from './job-settler.ts';
import { Jsonb } from './jsonb.ts';
import { LocalGroups } from './local-groups.ts';
import { QueueCache } from './queue-cache.ts';
import { QueueRows } from './queue-rows.ts';
import type { QueueRow } from './queue-rows.ts';
import { Recurrence } from './recurrence.ts';
import { Row } from './rows.ts';
import { SQLITE_QUEUE_SCHEMA } from './schema.ts';
import { SqlValues } from './sql-values.ts';
import { StartAfter } from './start-after.ts';
import { Supervisor } from './supervisor.ts';
import { Throttle } from './throttle.ts';
import { Timers } from './timers.ts';
import { Uuid } from './uuid.ts';
import { Worker } from './worker.ts';

// A slot missed by more than this is abandoned, not replayed: the cursor moves
// to the next occurrence and nothing is sent. Matches pg-boss, which fires a
// cron only while its previous occurrence is under 60s old, so both backends
// answer "the process was down through a slot" the same way.
const SCHEDULE_GRACE_SECONDS = 60;

export { DatabaseError } from './database-error.ts';
export { UnsupportedStartAfterError } from './start-after.ts';

export type { FoundJob, JobQueue } from './job-queue.ts';

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

// pg-boss emits a spread copy of a worker's error, not the Error itself
// (node_modules/pg-boss/dist/manager.js:992-994): an Error's message, stack and
// name are non-enumerable, so the payload carries only the fields set here and
// is not `instanceof Error`.
function toWorkerEvent(error: Error, queue: string, workerId: string) {
  return spreadCopy(error, { queue, worker: workerId });
}

// pg-boss's spread copy of an error it emits (node_modules/pg-boss/dist/
// manager.js:846).
function toErrorEvent(error: unknown) {
  return spreadCopy(toError(error), {});
}

// `{ ...error, message: error.message, stack: error.stack, ...extra }`.
// The stack is copied as is, also when an Error has none, a value Error's
// type cannot hold under exactOptionalPropertyTypes: the key is made in its
// place, then given the value.
function spreadCopy<T extends object>(error: Error, extra: T): Error & T {
  const copy = { ...error, message: error.message, stack: '', ...extra };
  Object.defineProperty(copy, 'stack', { value: error.stack });
  return copy;
}

export interface SqliteJobQueueOptions extends Pick<
  MaintenanceOptions,
  | 'supervise'
  | 'superviseIntervalSeconds'
  | 'monitorIntervalSeconds'
  | 'maintenanceIntervalSeconds'
  | 'queueCacheIntervalSeconds'
  | 'warningQueueSize'
> {
  path?: string;
  database?: DatabaseSync;
  clock?: Clock;
  useListenNotify?: boolean;
  schedule?: boolean;
  schedulePollingIntervalMs?: number;
}

type ScheduleRow = {
  queue_name: string;
  key: string;
  cron: string;
  timezone: string;
  data: string | null;
  options: string;
  next_run_on: string;
};

function mapScheduleRow(value: unknown): ScheduleRow {
  const row = Row.parse(value, 'schedule');
  return {
    queue_name: Row.readString(row, 'queue_name'),
    key: Row.readString(row, 'key'),
    cron: Row.readString(row, 'cron'),
    timezone: Row.readString(row, 'timezone'),
    data: Row.readNullableString(row, 'data'),
    options: Row.readString(row, 'options'),
    next_run_on: Row.readString(row, 'next_run_on'),
  };
}

// The database start() opened or the caller gave, or none.
type Connection = { kind: 'closed' } | { kind: 'open'; database: DatabaseSync };

type ManagerPhase =
  { kind: 'unstarted' } | { kind: 'started' } | { kind: 'stopped' };

type NotifierPhase = { kind: 'available' } | { kind: 'unavailable' };

type LifecyclePhase =
  { kind: 'stopped' } | { kind: 'armed' } | { kind: 'running' };

type ScheduleMonitorPhase =
  { kind: 'idle' } | { kind: 'polling'; timer: ReturnType<typeof setInterval> };

function normalizeOptions(
  options?: string | SqliteJobQueueOptions,
): SqliteJobQueueOptions {
  if (typeof options === 'string' || options === undefined) {
    return {
      path: options ?? ':memory:',
      schedule: true,
      schedulePollingIntervalMs: 1000,
    };
  }

  return {
    ...options,
    path: options.path ?? ':memory:',
    schedule: options.schedule ?? true,
    schedulePollingIntervalMs: options.schedulePollingIntervalMs ?? 1000,
  };
}

export class SqliteJobQueue
  extends EventEmitter<
    Pick<PgBossEventMap, 'error' | 'warning' | 'wip' | 'stopped'>
  >
  implements JobQueue
{
  // Like pg-boss (node_modules/pg-boss/dist/index.js:484-491): a `path` makes
  // the queue own its database, opened by start() and refusing SQL until then
  // (db.js:89); a caller-supplied `database` is used as is, like pg-boss's
  // `db` adapter, so SQL before start() fails on the missing schema.
  #connection: Connection;
  readonly #path: string;
  readonly #ownsDatabase: boolean;
  // pg-boss's manager #stopped, set in start() and stop(), so work() before
  // the first start() is allowed (node_modules/pg-boss/dist/
  // manager.js:912-914).
  #manager: ManagerPhase = { kind: 'unstarted' };
  readonly #clock: Clock;
  readonly #useListenNotify: boolean;
  readonly #warnedFetchOptions = new Set<string>();
  // pg-boss's notifier.available (node_modules/pg-boss/dist/notifier.js:28):
  // this process is its own LISTEN/NOTIFY listener from start() to stop() when
  // useListenNotify is on. Its wakes stay in this instance: another instance on
  // the same file never hears them, where every pg-boss listener on a schema
  // hears a NOTIFY.
  #notifier: NotifierPhase = { kind: 'unavailable' };
  // PgBoss's own #stopped and #started (node_modules/pg-boss/dist/
  // index.js:64, 124, 256): armed before a start runs, so stop() can shut
  // down what a start that threw partway left armed.
  #lifecycle: LifecyclePhase = { kind: 'stopped' };
  #starting: InFlight<this> | null = null;
  #stopping: InFlight<void> | null = null;
  readonly #activity = new Activity();
  #attachment: AsyncDisposable | null = null;
  // When wip last went out, first read at construction
  // (node_modules/pg-boss/dist/manager.js:194).
  #wipTs: number;
  #wipInterval: ClockTimer | undefined;
  readonly #queueCache = new QueueCache();
  readonly #queueCacheIntervalSeconds: number;
  #queueCacheInterval: ClockTimer | undefined;
  // The offWork() cleanups a stop waits for, each opened once it settles.
  readonly #pendingCleanups = new Set<Latch>();
  readonly #localGroups = new LocalGroups();
  readonly #supervisor: Supervisor;
  private readonly scheduleEnabled: boolean;
  private readonly schedulePollingIntervalMs: number;
  private readonly workers = new Map<string, Worker<JobRow>>();
  #scheduleMonitor: ScheduleMonitorPhase = { kind: 'idle' };

  constructor(options?: string | SqliteJobQueueOptions) {
    super();
    const normalized = normalizeOptions(options);
    this.#connection =
      normalized.database === undefined
        ? { kind: 'closed' }
        : { kind: 'open', database: normalized.database };
    this.#path = normalized.path ?? ':memory:';
    this.#ownsDatabase = normalized.database === undefined;
    // node_modules/pg-boss/dist/attorney.js:419, 421, 425
    this.#clock = Attorney.applyClockConfig(normalized.clock);
    const intervals = Attorney.applyOpsConfig(normalized);
    Attorney.validateWarningConfig(normalized);
    this.#queueCacheIntervalSeconds = intervals.queueCacheIntervalSeconds;
    this.#supervisor = new Supervisor(this.#clock, this.#activity, {
      ...intervals,
      // attorney.js:413
      supervise: 'supervise' in normalized ? normalized.supervise : true,
      warningQueueSize: normalized.warningQueueSize,
    });
    // index.js:87-88, 101-104
    this.#supervisor.on('error', (error) => this.emit('error', error));
    this.#supervisor.on('warning', (warning) => this.emit('warning', warning));
    this.#wipTs = this.#clock.now();
    // node_modules/pg-boss/dist/attorney.js:416
    this.#useListenNotify = normalized.useListenNotify ?? false;
    this.scheduleEnabled = normalized.schedule ?? true;
    this.schedulePollingIntervalMs =
      normalized.schedulePollingIntervalMs ?? 1000;
  }

  #now(): Date {
    return new Date(this.#clock.now());
  }

  private get db(): DatabaseSync {
    assert(
      this.#connection.kind === 'open',
      'Database not opened. Call open() before executing SQL.',
    );
    return this.#connection.database;
  }

  // node_modules/pg-boss/dist/index.js:106-132: a stop in flight finishes
  // first, and a concurrent start shares the one in flight.
  async start(): Promise<this> {
    if (this.#stopping) {
      await this.#stopping.settled();
    }
    if (this.#starting) {
      return this.#starting.result();
    }
    if (this.#lifecycle.kind === 'running') {
      return this;
    }
    this.#lifecycle = { kind: 'armed' };
    const starting = this.#doStart();
    this.#starting = new InFlight(starting);
    try {
      return await starting;
    } finally {
      this.#starting = null;
    }
  }

  // index.js:133-170: the clock attaches once the schema exists and before
  // anything arms a timer.
  async #doStart(): Promise<this> {
    if (this.#connection.kind === 'closed') {
      this.#connection = {
        kind: 'open',
        database: new DatabaseSync(this.#path),
      };
    }
    this.applySchema();
    if (Activity.isAttachable(this.#clock)) {
      this.#attachment = await this.#activity.attach(this.#clock);
    }
    this.#manager = { kind: 'started' };
    // manager.js:823-837: the cache refresh, then wip, both on the clock in
    // that order, then the cache's first load.
    this.#queueCacheInterval = this.#clock.setInterval(() => {
      void this.#onCacheQueues(true);
    }, this.#queueCacheIntervalSeconds * 1000);
    this.#wipInterval = this.#clock.setInterval(
      () => this.#onWipInterval(),
      2000,
    );
    await this.#onCacheQueues(false);
    this.startScheduleMonitor();
    if (this.#useListenNotify) {
      this.#notifier = { kind: 'available' };
      await this.#activity.deliver(() => this.wakeNotifyQueueWorkers());
    }
    // index.js:159-160
    this.#supervisor.start(this.db);
    this.#lifecycle = { kind: 'running' };
    return this;
  }

  // node_modules/pg-boss/dist/index.js:192-275.
  async stop(options: StopOptions = {}): Promise<void> {
    if (this.#starting) {
      await this.#starting.settled();
    }
    if (this.#stopping) {
      return this.#stopping.result();
    }
    const { close = true, graceful = true } = options;
    // An instance not running is already stopped; asked to close, one that
    // still holds its own database closes it.
    if (this.#lifecycle.kind === 'stopped') {
      if (close) {
        this.#closeOwnDatabase();
      }
      return;
    }
    const timeout = Math.max(options.timeout ?? 30000, 1000);
    const stopping = this.#doStop(close, graceful, timeout);
    this.#stopping = new InFlight(stopping);
    try {
      return await stopping;
    } finally {
      this.#stopping = null;
    }
  }

  async #doStop(
    close: boolean,
    graceful: boolean,
    timeout: number,
  ): Promise<void> {
    // pg-boss closes its listener first, still listening through the close's
    // I/O (node_modules/pg-boss/dist/index.js:228, notifier.js:70-77), so a
    // fetch in flight lands before the workers stop and their group tracking
    // is cleared.
    if (this.#notifier.kind === 'available') {
      await setImmediate();
    }
    this.#notifier = { kind: 'unavailable' };
    // manager.js:866-880: refuse new work and let every worker wind down.
    this.#manager = { kind: 'stopped' };
    this.#clock.clearInterval(this.#queueCacheInterval);
    this.#clock.clearInterval(this.#wipInterval);
    const names = new Set(Array.from(this.workers.values(), (w) => w.name));
    await Promise.allSettled(
      Array.from(names, (name) => this.offWork(name, { wait: false })),
    );
    this.#localGroups.clear();
    if (this.#scheduleMonitor.kind === 'polling') {
      clearInterval(this.#scheduleMonitor.timer);
      this.#scheduleMonitor = { kind: 'idle' };
    }
    // index.js:231
    await this.#supervisor.stop();
    // pg-boss awaits its notifier, timekeeper, navigator and bam stops here
    // (node_modules/pg-boss/dist/index.js:227-233); in those turns
    // an idle worker finishes stopping and leaves the workers failWip fails,
    // even with the stale jobs a throwing batch left on it (worker.js:66-70).
    await setImmediate();
    const shutdown = async () => {
      await this.#failWip();
      const attachment = this.#attachment;
      this.#attachment = null;
      await attachment?.[Symbol.asyncDispose]();
      if (close) {
        this.#closeOwnDatabase();
      }
      this.#lifecycle = { kind: 'stopped' };
      this.emit('stopped');
    };
    if (!graceful) {
      await shutdown();
      return;
    }
    // Real time, not the configured clock: the deadline bounds shutdown, and
    // under a test clock nothing would tick it while stop() waits.
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      deadlineTimer = setTimeout(resolve, timeout);
    });
    try {
      await Promise.race([this.#settleCleanups(), deadline]);
    } finally {
      clearTimeout(deadlineTimer);
    }
    await shutdown();
  }

  #closeOwnDatabase(): void {
    if (this.#ownsDatabase && this.#connection.kind === 'open') {
      this.#connection.database.close();
      this.#connection = { kind: 'closed' };
    }
  }

  // manager.js:884-909: fail each worker's batch, then abandon it. A failure
  // is reported rather than thrown, so every worker is still reached.
  async #failWip(): Promise<void> {
    for (const worker of this.workers.values()) {
      const ids = worker.jobs.map((job) => job.id);
      if (ids.length > 0) {
        try {
          this.#settle(worker.name, () =>
            JobSettler.fail(
              this.db,
              worker.name,
              ids,
              'pg-boss shut down while active',
              worker.jobs.map((job) => job.retry_count),
              this.#now(),
            ),
          );
        } catch (error) {
          try {
            this.emit(
              'error',
              toWorkerEvent(toError(error), worker.name, worker.id),
            );
          } catch {
            // An error event nobody listens for throws back out of emit();
            // the remaining workers still have to be reached.
          }
        }
      }
      worker.abort();
    }
  }

  // manager.js:839-848: a refresh that fails keeps the cache it had, and only
  // the interval's reports it.
  async #onCacheQueues(emit: boolean): Promise<void> {
    try {
      const queues = await this.#activity.query(() =>
        this.db
          .prepare('SELECT * FROM pgboss_queue')
          .all()
          .map(QueueRows.decode),
      );
      this.#queueCache.replace(queues);
    } catch (error) {
      if (emit) {
        this.emit('error', toErrorEvent(error));
      }
    }
  }

  // manager.js:827-836: while a worker holds jobs, at least 2000 ms apart.
  #onWipInterval(): void {
    const now = this.#clock.now();
    if (now - this.#wipTs < 2000) {
      return;
    }
    const wip = this.#getWipData();
    if (wip.some((worker) => worker.count > 0)) {
      this.emit('wip', wip);
      this.#wipTs = now;
    }
  }

  // manager.js:1067-1075: before and after each batch, strictly more than
  // 2000 ms apart.
  #emitWip(): void {
    const now = this.#clock.now();
    if (now - this.#wipTs > 2000) {
      this.emit('wip', this.#getWipData());
      this.#wipTs = now;
    }
  }

  // manager.js:1076-1081
  #getWipData(): WipData[] {
    return Array.from(this.workers.values(), (worker) =>
      worker.toWipData(),
    ).filter((worker) => worker.state !== 'stopped');
  }

  // manager.js:1095-1125: stops the queue's workers, or one work() call's
  // (by its id), and waits for their batches unless told not to.
  async offWork(
    name: string,
    options: OffWorkOptions = { wait: true },
  ): Promise<void> {
    assert(name, 'queue name is required');
    assert(typeof name === 'string', 'queue name must be a string');
    const workers = Array.from(this.workers.values()).filter(
      (worker) =>
        worker.name === name &&
        (options?.id
          ? worker.id === options.id || worker.workId === options.id
          : true),
    );
    if (workers.length === 0) {
      return;
    }
    const cleanup = Promise.allSettled(
      workers.map(async (worker) => {
        await worker.stop();
        this.workers.delete(worker.id);
      }),
    );
    if (options.wait) {
      await cleanup;
      this.#forgetLocalGroups(name);
    } else {
      const pending = new Latch();
      this.#pendingCleanups.add(pending);
      const settled = () => {
        this.#pendingCleanups.delete(pending);
        this.#forgetLocalGroups(name);
        pending.open();
      };
      cleanup.then(settled, settled);
    }
  }

  // manager.js:463-471: a queue's group tracking goes with its last worker
  // neither stopping nor stopped.
  #forgetLocalGroups(name: string): void {
    const live = Array.from(this.workers.values()).some(
      (worker) => worker.name === name && !worker.stopping && !worker.stopped,
    );
    if (!live) {
      this.#localGroups.forget(name);
    }
  }

  // manager.js:1088-1094: resolves once no worker is still stopping.
  async #settleCleanups(): Promise<void> {
    while (this.#pendingCleanups.size > 0) {
      await Promise.all(
        Array.from(this.#pendingCleanups, (pending) => pending.wait()),
      );
    }
  }

  async createQueue(
    name: string,
    options: Omit<Queue, 'name'> = {},
  ): Promise<void> {
    // node_modules/pg-boss/dist/manager.js:2005-2013. `partition` is a pg-boss
    // storage layout (a table per queue) with no observable effect, so it is
    // accepted and has nothing to store here.
    Attorney.assertQueueName(name);
    const policy = options.policy || policies.standard;
    assert(policy in policies, `${policy} is not a valid queue policy`);
    Attorney.validateQueueArgs(options);
    if (options.deadLetter) {
      Attorney.assertQueueName(options.deadLetter);
      assert.notStrictEqual(
        name,
        options.deadLetter,
        'deadLetter cannot be itself',
      );
      this.getQueueOrThrow(options.deadLetter);
    }

    this.db
      .prepare(
        `INSERT OR IGNORE INTO pgboss_queue (
          name,
          policy,
          retry_limit,
          retry_delay_seconds,
          retry_backoff,
          retry_delay_max_seconds,
          expire_seconds,
          retention_seconds,
          deletion_seconds,
          heartbeat_seconds,
          dead_letter,
          warning_queue_size,
          notify
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        name,
        policy,
        options.retryLimit ?? 2,
        options.retryDelay ?? 0,
        SqlValues.toSqlBool(options.retryBackoff) ?? 0,
        options.retryDelayMax ?? null,
        options.expireInSeconds ?? 900,
        options.retentionSeconds ?? 1_209_600,
        options.deleteAfterSeconds ?? 604_800,
        options.heartbeatSeconds ?? null,
        options.deadLetter ?? null,
        options.warningQueueSize ?? 0,
        SqlValues.toSqlBool(options.notify) ?? 0,
      );
    this.#queueCache.evict(name);
  }

  async updateQueue(
    name: string,
    options: UpdateQueueOptions = {},
  ): Promise<void> {
    // pg-boss counts keys, not defined values, rejects the two settings fixed
    // at creation, then validates every key present
    // (node_modules/pg-boss/dist/manager.js:2049-2057).
    Attorney.assertQueueName(name);
    assert(Object.keys(options).length > 0, 'no properties found to update');
    if ('policy' in options) {
      throw new Error('queue policy cannot be changed after creation');
    }
    if ('partition' in options) {
      throw new Error('queue partitioning cannot be changed after creation');
    }
    Attorney.validateQueueArgs(options);
    // null clears the dead letter queue; only a name is checked
    // (manager.js:2058-2064).
    const { deadLetter } = options;
    if (deadLetter !== null && deadLetter !== undefined) {
      Attorney.assertQueueName(deadLetter);
      assert.notStrictEqual(name, deadLetter, 'deadLetter cannot be itself');
    }
    const entries = [
      ...this.mapQueueUpdateOptions(options),
      ['updated_on', SqlValues.asIso(this.#now())] as const,
    ];
    const assignments = entries.map(([column]) => `${column} = ?`).join(', ');
    const values = entries.map(([, value]) => value);

    try {
      this.db
        .prepare(
          `UPDATE pgboss_queue
          SET ${assignments}
          WHERE name = ?`,
        )
        .run(...values, name);
    } catch (error) {
      if (Database.isForeignKeyViolation(error)) {
        throw new DatabaseError(
          'insert or update on table "queue" violates foreign key constraint "queue_dead_letter_fkey"',
          '23503',
        );
      }
      throw error;
    }
    this.#queueCache.evict(name);
  }

  async deleteQueue(name: string): Promise<void> {
    Attorney.assertQueueName(name);
    try {
      this.db.prepare('DELETE FROM pgboss_queue WHERE name = ?').run(name);
    } catch (error) {
      if (!Database.isForeignKeyViolation(error)) {
        throw error;
      }
      // A queue's dead letter reference refuses the delete; a job's is
      // RESTRICT (node_modules/pg-boss/dist/plans.js:321, 878-881).
      const usedByQueue = this.db
        .prepare('SELECT 1 FROM pgboss_queue WHERE dead_letter = ?')
        .get(name);
      throw usedByQueue === undefined
        ? new DatabaseError(
            'update or delete on table "queue" violates RESTRICT setting of foreign key constraint "dlq_fkey" on table "job_common"',
            '23001',
          )
        : new DatabaseError(
            'update or delete on table "queue" violates foreign key constraint "queue_dead_letter_fkey" on table "queue"',
            '23503',
          );
    }
    this.#queueCache.evict(name);
  }

  send(request: Request): Promise<string | null>;
  send<TData extends object>(
    name: string,
    data?: TData | null,
    options?: SendOptions,
  ): Promise<string | null>;
  // node_modules/pg-boss/dist/manager.js:1179-1182, 1232-1258.
  async send(...args: unknown[]): Promise<string | null> {
    const { name, data, options } = Attorney.checkSendArgs(args);
    // The insert is a statement like a fetch's claim: it runs when issued
    // and its outcome comes back over I/O.
    return this.#activity.query(() => {
      const queue = this.getQueueOrThrow(name);
      // node_modules/pg-boss/dist/manager.js:1238-1240
      if (queue.policy === policies.key_strict_fifo && !options.singletonKey) {
        throw new Error(
          `${policies.key_strict_fifo} queues require a singletonKey`,
        );
      }
      // pg-boss sends the job as one JSON text that json_to_recordset reads
      // (manager.js:1242, plans.js:2303), so the first escape no field can
      // hold refuses the send, whichever field holds it.
      Jsonb.assertEscapes(JobRows.payload(queue.name, data, options));
      const now = this.#now();
      const stored =
        this.#insertJob(queue.name, data, options, queue, now, {
          startAfter: options.startAfter,
          singletonOffset: 0,
        }) ??
        // manager.js:1253-1256: a send a unique index refused retries once into
        // the next throttle slot, starting when that slot does.
        (options.singletonNextSlot
          ? this.#insertJob(queue.name, data, options, queue, now, {
              startAfter: Throttle.debounceStartAfter(
                options.singletonSeconds,
                now,
              ),
              singletonOffset: options.singletonSeconds,
            })
          : null);
      if (stored === null) {
        return null;
      }
      // A notify queue's insert wakes the queue's workers when the stored job
      // is due now (node_modules/pg-boss/dist/plans.js:2335-2350), heard as
      // the insert runs (PGlite's src/pglite.ts:980-992 queues the NOTIFY
      // then) and only while this process listens (notifier.js:57).
      if (
        queue.notify &&
        this.#notifier.kind === 'available' &&
        stored.startAfter <= SqlValues.asIso(now)
      ) {
        this.notifyQueue(queue.name);
      }
      return stored.id;
    });
  }

  // One insert, returning the stored id and start_after; null when a unique
  // index (policy or throttle) refuses it, like pg-boss's ON CONFLICT DO
  // NOTHING (plans.js:2329).
  #insertJob(
    name: string,
    data: unknown,
    options: SendOptions,
    queue: QueueRow,
    now: Date,
    attempt: {
      startAfter: SendOptions['startAfter'];
      singletonOffset: SendOptions['singletonSeconds'];
    },
  ): { id: string; startAfter: string } | null {
    const startAfter = StartAfter.resolve(attempt.startAfter, now);
    const retentionSeconds =
      options.retentionSeconds ?? queue.retention_seconds;
    const keepUntil = SqlValues.addSeconds(startAfter, retentionSeconds);
    let inserted;
    try {
      inserted = this.db
        .prepare(
          `INSERT INTO pgboss_job (
          id,
          queue_name,
          data,
          policy,
          priority,
          retry_limit,
          retry_delay_seconds,
          retry_backoff,
          retry_delay_max_seconds,
          start_after,
          singleton_key,
          singleton_on,
          expire_seconds,
          retention_seconds,
          deletion_seconds,
          heartbeat_seconds,
          created_on,
          keep_until,
          dead_letter,
          group_id,
          group_tier
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
        RETURNING id, start_after`,
        )
        .get(
          options.id == null ? randomUUID() : Uuid.fromPayload(options.id),
          name,
          // pg-boss sends the job as JSON.stringify([job]), where a payload
          // JSON cannot hold drops to null (manager.js:1242).
          JSON.stringify(data) ?? 'null',
          queue.policy,
          options.priority ?? 0,
          options.retryLimit ?? queue.retry_limit,
          options.retryDelay ?? queue.retry_delay_seconds,
          SqlValues.toSqlBool(options.retryBackoff) ?? queue.retry_backoff,
          options.retryDelayMax ?? queue.retry_delay_max_seconds,
          SqlValues.asIso(startAfter),
          options.singletonKey ?? null,
          Throttle.slot(options.singletonSeconds, attempt.singletonOffset, now),
          options.expireInSeconds ?? queue.expire_seconds,
          retentionSeconds,
          options.deleteAfterSeconds ?? queue.deletion_seconds,
          options.heartbeatSeconds ?? queue.heartbeat_seconds,
          SqlValues.asIso(now),
          SqlValues.asIso(keepUntil),
          options.deadLetter ?? queue.dead_letter,
          options.group?.id ?? null,
          options.group?.tier ?? null,
        );
    } catch (error) {
      // The queue is already checked, so a refused reference is the dead
      // letter queue's (plans.js:878-881).
      if (Database.isForeignKeyViolation(error)) {
        throw new DatabaseError(
          'insert or update on table "job_common" violates foreign key constraint "dlq_fkey"',
          '23503',
        );
      }
      throw error;
    }
    return inserted === undefined
      ? null
      : {
          id: Row.readString(inserted, 'id'),
          startAfter: Row.readString(inserted, 'start_after'),
        };
  }

  work(name: string, handler: WorkHandler<unknown>): Promise<string>;
  work(
    name: string,
    options: WorkOptions,
    handler: WorkHandler<unknown>,
  ): Promise<string>;
  async work(
    name: string,
    ...args: [WorkHandler<unknown>] | [WorkOptions, WorkHandler<unknown>]
  ): Promise<string> {
    // The arguments are checked before the stopped state, as pg-boss does
    // (node_modules/pg-boss/dist/manager.js:910-914).
    const { pollingInterval, notifyPollingInterval } = Attorney.checkWorkArgs(
      name,
      args,
    );
    if (this.#manager.kind === 'stopped') {
      throw new Error('Workers are disabled. pg-boss is stopped');
    }
    const handler = args.length === 1 ? args[0] : args[1];
    const options: WorkOptions = args.length === 1 ? {} : args[0] || {};
    // checkWorkArgs' copy, own properties only, which work() reads and every
    // worker of this call reports in wip (node_modules/pg-boss/dist/
    // attorney.js:370, manager.js:911-915).
    const workerOptions = {
      ...options,
      pollingInterval,
      notifyPollingInterval,
    };

    // node_modules/pg-boss/dist/manager.js:915-1004. Read once, as pg-boss
    // destructures them here (915).
    const {
      batchSize = 1,
      localConcurrency = 1,
      burstWhenReadyExceeds,
      burstWhenBatchFull = false,
      includeMetadata = false,
      priority,
      orderByCreatedOn,
      heartbeatRefreshSeconds,
      minPriority,
      maxPriority,
      perJobResults = false,
      groupConcurrency,
      localGroupConcurrency,
      transactional = false,
    } = workerOptions;
    // pg-boss refuses a transactional worker unless its db adapter can open a
    // transaction (manager.js:919-920); SQLite's connection never can, so it
    // refuses every one, as pg-boss does on an adapter without
    // beginTransaction.
    assert(
      !transactional,
      'transactional workers require a database connection pg-boss can open a transaction on: the built-in pool, or a db adapter implementing beginTransaction',
    );
    if (localGroupConcurrency != null) {
      this.#localGroups.configure(name, localGroupConcurrency);
    }
    // The queue's notify flag as the last fetch read it (false when that read
    // threw). pg-boss reads it from a queue cache its fetch fills
    // (manager.js:850-864, 930), so choosing the wait does no I/O that could
    // fail outside the loop's catch.
    let queueNotifies = false;
    // The wait before each fetch: none after a full batch while the cached
    // ready count exceeds burstWhenReadyExceeds or when burstWhenBatchFull
    // asks (ignored at batchSize 1, where every fetch is full), the notify
    // backstop while this process hears the queue's notifications, else the
    // base poll (manager.js:928-949). The ready count is the monitor's, as the
    // cache last read it, and 0 for a queue it holds no entry for (932).
    const resolveInterval = (lastFetchCount: number) => {
      const readyCount = this.#queueCache.peek(name)?.ready_count ?? 0;
      const burst =
        lastFetchCount >= batchSize &&
        ((burstWhenReadyExceeds !== undefined &&
          readyCount > burstWhenReadyExceeds) ||
          (burstWhenBatchFull && batchSize > 1));
      if (burst) {
        return 0;
      }
      return this.#notifier.kind === 'available' && queueNotifies
        ? notifyPollingInterval
        : pollingInterval;
    };
    const firstWorkerId = randomUUID();
    for (let index = 0; index < localConcurrency; index++) {
      const workerId = index === 0 ? firstWorkerId : randomUUID();
      const worker: Worker<JobRow> = new Worker<JobRow>({
        id: workerId,
        workId: firstWorkerId,
        name,
        options: workerOptions,
        clock: this.#clock,
        resolveInterval,
        // pg-boss's claim runs as it is issued, ahead of any statement
        // issued after it, and comes back over I/O, so work() resolves
        // before its first fetch lands (manager.js:1575-1577).
        fetch: () => {
          // Read as the fetch starts, before its I/O (manager.js:951-955).
          const ignoreGroups =
            localGroupConcurrency == null
              ? undefined
              : this.#localGroups.atCapacity(name);
          return this.#activity.query(() => {
            this.#warnDeprecatedFetchOptions({ priority, orderByCreatedOn });
            queueNotifies = false;
            // pg-boss checks the queue on every fetch, not when work()
            // registers (node_modules/pg-boss/dist/manager.js:849-861).
            const queue = this.getQueueOrThrow(name);
            queueNotifies = queue.notify;
            return JobFetcher.claim(
              this.db,
              queue,
              {
                batchSize,
                minPriority,
                maxPriority,
                groupConcurrency,
                ignoreGroups,
                // The active keys the monitor last counted, as cached
                // (manager.js:1564-1572).
                ignoreSingletons:
                  this.#queueCache.fill(queue).singletons_active,
              },
              this.#now(),
            );
          });
        },
        onFetch: async (rows) => {
          if (rows.length === 0) {
            return;
          }
          this.#emitWip();
          const run = (jobs: JobRow[]) =>
            this.processJobs(
              name,
              jobs,
              handler,
              includeMetadata,
              worker,
              heartbeatRefreshSeconds,
              perJobResults,
            );
          if (localGroupConcurrency == null) {
            await run(rows);
          } else {
            // manager.js:970-988: the jobs over their group's local limit go
            // back to created before the handler sees the rest.
            const { allowed, excess, grouped } = this.#localGroups.start(
              name,
              rows,
            );
            try {
              if (excess.length > 0) {
                // The handler waits for the restore's I/O, as for the
                // fetch's.
                await this.#activity.query(() =>
                  this.#settle(name, () =>
                    JobSettler.restore(
                      this.db,
                      name,
                      excess.map((row) => row.id),
                    ),
                  ),
                );
                // Shutdown fails only the jobs this worker still holds.
                worker.jobs = allowed;
              }
              if (allowed.length > 0) {
                await run(allowed);
              }
            } finally {
              this.#localGroups.end(name, grouped);
            }
          }
          this.#emitWip();
        },
        onError: (error) => {
          this.emit('error', toWorkerEvent(error, name, workerId));
        },
      });
      this.workers.set(workerId, worker);
      worker.start();
    }
    return firstWorkerId;
  }

  async findJobs(
    name: string,
    options: FindJobsOptions = {},
  ): Promise<FoundJob<unknown>[]> {
    Attorney.assertQueueName(name);
    this.getQueueOrThrow(name);

    const where = ['queue_name = ?'];
    const values: SQLInputValue[] = [name];

    if (options.id !== undefined) {
      where.push('id = ?');
      values.push(Uuid.parameter(options.id));
    }

    if (options.key !== undefined) {
      where.push('singleton_key = ?');
      values.push(options.key);
    }

    if (options.queued) {
      where.push("state IN ('created', 'retry')");
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM pgboss_job
        WHERE ${where.join(' AND ')}
        ORDER BY created_on, id`,
      )
      .all(...values)
      .map(JobRows.decode);

    const filteredRows =
      options.data === undefined
        ? rows
        : rows.filter((row) =>
            Jsonb.contains(JSON.parse(row.data), options.data),
          );

    return filteredRows.map((row) => JobRows.toFound(row));
  }

  async cancel(
    name: string,
    id: string | string[] | JobAttempt | JobAttempt[],
  ) {
    Attorney.assertQueueName(name);
    const { ids, attempts } = Attorney.mapAttemptArg(id, 'cancel');
    this.getQueueOrThrow(name);

    return JobSettler.response(
      ids,
      JobSettler.cancel(this.db, name, ids, attempts, this.#now()),
    );
  }

  async fail(
    name: string,
    id: string | string[] | JobAttempt | JobAttempt[],
    data?: object | null,
  ) {
    Attorney.assertQueueName(name);
    const { ids, attempts } = Attorney.mapAttemptArg(id, 'fail');
    this.getQueueOrThrow(name);

    return JobSettler.response(
      ids,
      JobSettler.fail(this.db, name, ids, data, attempts, this.#now()),
    );
  }

  // node_modules/pg-boss/dist/timekeeper.js:812-849
  async schedule<TData extends object>(
    name: string,
    cron: string,
    data?: TData | null,
    options: ScheduleOptions = {},
  ): Promise<void> {
    const { tz: requestedTz, key = '', missed, ...rest } = options;
    const tz = requestedTz || 'UTC';
    const kind = Recurrence.isRrule(cron)
      ? scheduleKinds.rrule
      : scheduleKinds.cron;
    Recurrence.assertRecurrence(cron, tz);
    const now = this.#now();
    if (kind === scheduleKinds.rrule) {
      Recurrence.assertRruleSends(cron, tz, now);
    }
    Attorney.checkSendArgs([name, data, { ...rest }]);
    Attorney.assertKey(key);
    Recurrence.assertMissedPolicy(missed);
    try {
      // plans.js:1337-1349, plus the cursor the interim schedule monitor
      // reads, for cron rows only.
      this.db
        .prepare(
          `INSERT INTO pgboss_schedule (
            queue_name,
            key,
            kind,
            cron,
            timezone,
            data,
            options,
            next_run_on,
            created_on,
            updated_on
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(queue_name, key) DO UPDATE SET
            kind = excluded.kind,
            cron = excluded.cron,
            timezone = excluded.timezone,
            data = excluded.data,
            options = excluded.options,
            next_run_on = excluded.next_run_on,
            updated_on = excluded.updated_on`,
        )
        .run(
          name,
          SqlValues.text(key),
          kind,
          SqlValues.text(cron),
          tz,
          data == null ? null : Jsonb.parameter(data),
          Jsonb.parameter(options),
          kind === scheduleKinds.cron
            ? SqlValues.asIso(this.nextCronRun(cron, tz, now))
            : null,
          SqlValues.asIso(now),
          SqlValues.asIso(now),
        );
    } catch (error) {
      // timekeeper.js:844-847 names the queue a refused reference points
      // at; Postgres names the column a null violates.
      if (Database.isForeignKeyViolation(error)) {
        throw new DatabaseError(`Queue ${name} not found`, '23503');
      }
      const column = Database.notNullColumn(error);
      if (column !== undefined) {
        throw new DatabaseError(
          `null value in column "${column}" of relation "schedule" violates not-null constraint`,
          '23502',
        );
      }
      throw error;
    }
  }

  // timekeeper.js:850-853, plans.js:1350-1356
  async unschedule(name: string, key = ''): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM pgboss_schedule
        WHERE queue_name = ? AND key = ?`,
      )
      .run(SqlValues.text(name), SqlValues.text(key));
  }

  async runDueSchedules(): Promise<void> {
    const now = this.#now();
    const rows = this.db
      .prepare(
        `SELECT *
        FROM pgboss_schedule
        WHERE next_run_on <= ?
        ORDER BY next_run_on, queue_name, key`,
      )
      .all(SqlValues.asIso(now))
      .map(mapScheduleRow);

    for (const row of rows) {
      const staleSeconds =
        (now.getTime() - new Date(row.next_run_on).getTime()) / 1000;
      if (staleSeconds < SCHEDULE_GRACE_SECONDS) {
        const data: object | null =
          row.data === null ? null : JSON.parse(row.data);
        const options: SendOptions = JSON.parse(row.options);
        await this.send(row.queue_name, data, options);
      }
      const nextRunOn = this.nextCronRun(row.cron, row.timezone, now);
      this.db
        .prepare(
          `UPDATE pgboss_schedule
          SET next_run_on = ?, updated_on = ?
          WHERE queue_name = ? AND key = ?`,
        )
        .run(
          SqlValues.asIso(nextRunOn),
          SqlValues.asIso(now),
          row.queue_name,
          row.key,
        );
    }
  }

  private applySchema(): void {
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    for (const statement of SQLITE_QUEUE_SCHEMA) {
      this.db.exec(statement);
    }
  }

  // Still on real time: the timekeeper's timers move onto the clock with
  // slice 9 (node_modules/pg-boss/dist/timekeeper.js).
  private startScheduleMonitor(): void {
    if (!this.scheduleEnabled || this.#scheduleMonitor.kind === 'polling') {
      return;
    }

    const timer = setInterval(() => {
      void this.runDueSchedules().catch((error: unknown) => {
        this.emit('error', toError(error));
      });
    }, this.schedulePollingIntervalMs);
    this.#scheduleMonitor = { kind: 'polling', timer };
  }

  private mapQueueUpdateOptions(options: UpdateQueueOptions) {
    const entries: Array<[string, SQLInputValue]> = [];

    this.pushOption(entries, 'retry_limit', options.retryLimit);
    this.pushOption(entries, 'retry_delay_seconds', options.retryDelay);
    this.pushOption(
      entries,
      'retry_backoff',
      SqlValues.toSqlBool(options.retryBackoff),
    );
    this.pushClearableOption(
      entries,
      'retry_delay_max_seconds',
      options.retryDelayMax,
    );
    this.pushOption(entries, 'expire_seconds', options.expireInSeconds);
    this.pushOption(entries, 'retention_seconds', options.retentionSeconds);
    this.pushOption(entries, 'deletion_seconds', options.deleteAfterSeconds);
    this.pushClearableOption(
      entries,
      'heartbeat_seconds',
      options.heartbeatSeconds,
    );
    this.pushClearableOption(entries, 'dead_letter', options.deadLetter);
    this.pushOption(entries, 'warning_queue_size', options.warningQueueSize);
    this.pushOption(entries, 'notify', SqlValues.toSqlBool(options.notify));

    return entries;
  }

  // COALESCE((o.data->>key)::type, column) (node_modules/pg-boss/dist/
  // plans.js:1159-1161, 1165-1168, 1172): a null keeps the stored value, as
  // an absent key does.
  private pushOption(
    entries: Array<[string, SQLInputValue]>,
    column: string,
    value: SQLInputValue | undefined,
  ): void {
    if (value !== undefined && value !== null) {
      entries.push([column, value]);
    }
  }

  // CASE WHEN (o.data -> key) IS NOT NULL (plans.js:1162-1164, 1169-1171,
  // 1173-1175): a present key is written, so null clears the column.
  private pushClearableOption(
    entries: Array<[string, SQLInputValue]>,
    column: string,
    value: SQLInputValue | undefined,
  ): void {
    if (value !== undefined) {
      entries.push([column, value]);
    }
  }

  private findQueue(name: string): QueueRow | undefined {
    const queue = this.db
      .prepare('SELECT * FROM pgboss_queue WHERE name = ?')
      .get(name);
    return queue === undefined ? undefined : QueueRows.decode(queue);
  }

  // pg-boss looks a queue up through getQueueCache, whose cache miss validates
  // the name first and fills the cache (node_modules/pg-boss/dist/
  // manager.js:849-861, 2028-2033).
  private getQueueOrThrow(name: unknown): QueueRow {
    Attorney.assertQueueName(name);
    const queue = this.findQueue(name);
    if (!queue) {
      throw new Error(`Queue ${name} does not exist`);
    }
    this.#queueCache.fill(queue);
    return queue;
  }

  private nextCronRun(cron: string, timezone: string, currentDate: Date): Date {
    return CronExpressionParser.parse(cron, {
      currentDate,
      tz: timezone,
    })
      .next()
      .toDate();
  }

  // A DeprecationWarning, not a queue event, once per option per instance and
  // only when the option is set to false (node_modules/pg-boss/dist/
  // manager.js:133-139, 1552-1559).
  #warnDeprecatedFetchOptions(options: {
    priority: boolean | undefined;
    orderByCreatedOn: boolean | undefined;
  }): void {
    for (const option of ['priority', 'orderByCreatedOn'] as const) {
      if (options[option] === false && !this.#warnedFetchOptions.has(option)) {
        this.#warnedFetchOptions.add(option);
        process.emitWarning(
          `${option}: false is deprecated and now ignored. Jobs are always fetched in priority and creation order. Remove it; it will be rejected in the next major.`,
          'DeprecationWarning',
          'PGBOSS_DEP_FETCH_SORT',
        );
      }
    }
  }

  // Wakes every worker of a queue, busy ones included, so each fetches now
  // instead of waiting out its poll (node_modules/pg-boss/dist/manager.js:
  // 1137-1143).
  private notifyQueue(name: string): void {
    for (const worker of this.workers.values()) {
      if (worker.name === name) {
        worker.notify();
      }
    }
  }

  // PGlite's listener reports a connect once it subscribes, and pg-boss then
  // wakes every worker of a notify queue to fetch what it may have missed
  // (node_modules/pg-boss/dist/adapters/pglite.js:144-152,
  // manager.js:1144-1152).
  private wakeNotifyQueueWorkers(): void {
    for (const worker of this.workers.values()) {
      if (this.findQueue(worker.name)?.notify) {
        worker.notify();
      }
    }
  }

  // node_modules/pg-boss/dist/manager.js:513-663, without transactions, which
  // slice 8 ports. The handler races a deadline of the batch's largest
  // expireInSeconds on a controller every job's signal follows; the race aborts
  // it when it settles. A job's signal also follows its own claim, which a
  // heartbeat aborts once the claim is gone.
  private async processJobs(
    name: string,
    rows: JobRow[],
    handler: WorkHandler<unknown>,
    includeMetadata: boolean,
    worker: Worker<JobRow>,
    heartbeatRefreshSeconds: number | undefined,
    perJobResults: boolean,
  ): Promise<void> {
    const ids = rows.map((row) => row.id);
    // work() settles with the jobs it claimed, fenced to their attempts
    // (manager.js:628, 652).
    const attempts = rows.map((row) => row.retry_count);
    const maxExpiration = rows.reduce(
      (max, row) => Math.max(max, row.expire_seconds),
      0,
    );
    const batch = new AbortController();
    worker.abortController = batch;
    const claimed = rows.map((row) => ({ row, claim: new AbortController() }));
    // manager.js:529-530: the batch's signal or the job's own claim.
    const jobs = claimed.map(({ row, claim }) =>
      JobRows.toJob(
        row,
        includeMetadata,
        AbortSignal.any([batch.signal, claim.signal]),
      ),
    );
    const heartbeatTimer = this.#startHeartbeat(
      name,
      claimed,
      heartbeatRefreshSeconds,
    );
    try {
      const result = await Timers.resolveWithinSeconds(
        this.#clock,
        handler(jobs),
        maxExpiration,
        `handler execution exceeded ${maxExpiration}s`,
        batch,
      );
      if (perJobResults) {
        this.#settlePerJob(name, rows, result);
      } else {
        // The result is stored only for a batch of one (manager.js:628).
        this.#settle(name, () =>
          JobSettler.complete(
            this.db,
            name,
            ids,
            attempts,
            ids.length === 1 ? result : undefined,
            this.#now(),
          ),
        );
      }
    } catch (error) {
      this.#settle(name, () =>
        JobSettler.fail(this.db, name, ids, error, attempts, this.#now()),
      );
    } finally {
      if (heartbeatTimer) {
        this.#clock.clearInterval(heartbeatTimer);
      }
      worker.abortController = null;
    }
  }

  // manager.js:355-405: the handler's results settle each job of the batch.
  // Entries without an id and status, naming no job of the batch by its exact
  // id, or carrying another status are ignored, the last valid entry per job
  // wins, and a job without one fails. The completed, failed and dead-lettered jobs then
  // settle in that order, each group on its own (393-396), so a group that
  // throws leaves the groups before it settled.
  #settlePerJob(name: string, rows: JobRow[], result: unknown): void {
    if (!Array.isArray(result)) {
      this.#settle(name, () =>
        JobSettler.fail(
          this.db,
          name,
          rows.map((row) => row.id),
          new Error(
            'perJobResults handler must resolve with an array of job results',
          ),
          rows.map((row) => row.retry_count),
          this.#now(),
        ),
      );
      return;
    }
    // Keyed by whatever id an entry names: only the batch's own ids are read.
    const dispositions = new Map<unknown, object>();
    for (const item of result) {
      if (
        (typeof item === 'object' || typeof item === 'function') &&
        item !== null &&
        'id' in item &&
        'status' in item &&
        (item.status === 'completed' ||
          item.status === 'failed' ||
          item.status === 'deadletter')
      ) {
        dispositions.set(item.id, item);
      }
    }
    const completed: JobOutcome[] = [];
    const failed: JobOutcome[] = [];
    const deadLettered: JobOutcome[] = [];
    for (const row of rows) {
      const item = dispositions.get(row.id);
      const status = item && 'status' in item ? item.status : undefined;
      const outcome = {
        id: row.id,
        retryCount: row.retry_count,
        output: item && 'output' in item ? item.output : undefined,
      };
      if (status === 'completed') {
        completed.push(outcome);
      } else if (status === 'failed') {
        failed.push(outcome);
      } else if (status === 'deadletter') {
        deadLettered.push(outcome);
      } else {
        failed.push({
          ...outcome,
          output: new Error('no disposition returned by handler'),
        });
      }
    }
    // An empty group runs no statement (manager.js:394-396).
    if (completed.length > 0) {
      this.#settle(name, () =>
        JobSettler.completeWithOutputs(this.db, name, completed, this.#now()),
      );
    }
    if (failed.length > 0) {
      this.#settle(name, () =>
        JobSettler.failWithOutputs(this.db, name, failed, false, this.#now()),
      );
    }
    if (deadLettered.length > 0) {
      this.#settle(name, () =>
        JobSettler.failWithOutputs(
          this.db,
          name,
          deadLettered,
          true,
          this.#now(),
        ),
      );
    }
  }

  // A worker's settle looks its queue up first, as pg-boss's complete(),
  // fail(), restore() and per-job settles do (manager.js:411, 430, 1641,
  // 1680, 1979), so a queue deleted under a running batch makes the settle
  // throw.
  #settle<T>(name: string, write: () => T): T {
    this.getQueueOrThrow(name);
    return write();
  }

  // manager.js:520-565: every heartbeatRefreshSeconds, or half the batch's
  // shortest heartbeatSeconds, touch the attempts still held; a job the touch
  // no longer finds active under this claim loses its own signal. Without a
  // heartbeat nothing is touched or aborted.
  #startHeartbeat(
    name: string,
    claimed: { row: JobRow; claim: AbortController }[],
    heartbeatRefreshSeconds: number | undefined,
  ) {
    const candidates = claimed
      .map(({ row }) => row.heartbeat_seconds ?? 0)
      .filter((seconds) => seconds > 0);
    if (candidates.length === 0) {
      return null;
    }
    const refreshSeconds =
      heartbeatRefreshSeconds ?? Math.min(...candidates) / 2;
    return this.#clock.setInterval(() => {
      const held = claimed.filter(({ claim }) => !claim.signal.aborted);
      if (held.length === 0) {
        return;
      }
      let refreshed: Set<string>;
      try {
        this.getQueueOrThrow(name);
        refreshed = JobSettler.touch(
          this.db,
          name,
          held.map(({ row }) => row),
          this.#now(),
        );
      } catch (error) {
        // A heartbeat that could not run says nothing about the claim.
        this.emit('error', toError(error));
        return;
      }
      for (const { row, claim } of held) {
        if (!refreshed.has(row.id)) {
          claim.abort(
            new Error(
              `job ${row.id} is no longer active under this worker's claim`,
            ),
          );
        }
      }
    }, refreshSeconds * 1000);
  }
}
