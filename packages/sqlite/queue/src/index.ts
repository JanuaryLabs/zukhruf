import assert, { AssertionError } from 'node:assert';
import { hash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';

import {
  type Clock,
  type ClockTimer,
  type CompleteOptions,
  type FetchOptions,
  type FindJobsOptions,
  type Job,
  type JobAttempt,
  type JobWithMetadata,
  type MaintenanceOptions,
  type OffWorkOptions,
  type PgBossEventMap,
  type Queue,
  type QueueStats,
  type QueueStatsOptions,
  type Request,
  type ScheduleOptions,
  type SchedulingOptions,
  type SendOptions,
  type StopOptions,
  type UpdateQueueOptions,
  type WipData,
  type WorkHandler,
  type WorkOptions,
  policies,
  scheduleKinds,
  schedulePrecisions,
  systemClock,
} from 'pg-boss';

import { WaitGroup } from '@zukhruf/async';
import { Notifications } from '@zukhruf/sqlite-notify';
import { WriteAheadLog, open } from '@zukhruf/sqlite-open';
import { transaction } from '@zukhruf/sqlite-transaction';

import { Activity } from './activity.ts';
import { Attorney } from './attorney.ts';
import type { SuperviseIntervals } from './attorney.ts';
import { Contractor } from './contractor.ts';
import { DatabaseError } from './database-error.ts';
import { Database } from './database.ts';
import { CurrentOperation } from './in-flight.ts';
import { JobFetcher } from './job-fetcher.ts';
import type { FoundJob, JobQueue, StartOptions } from './job-queue.ts';
import { JobRows } from './job-rows.ts';
import type { JobRow } from './job-rows.ts';
import { JobSettler } from './job-settler.ts';
import type { JobOutcome } from './job-settler.ts';
import { Jsonb } from './jsonb.ts';
import { LocalGroups } from './local-groups.ts';
import { QueueCache } from './queue-cache.ts';
import { QueueRows } from './queue-rows.ts';
import type { QueueRow } from './queue-rows.ts';
import { QueueStatsCache } from './queue-stats-cache.ts';
import type { CachedQueueStats } from './queue-stats-cache.ts';
import { Recurrence } from './recurrence.ts';
import { Row } from './rows.ts';
import { SqlValues } from './sql-values.ts';
import { StartAfter } from './start-after.ts';
import { Supervisor } from './supervisor.ts';
import { Throttle } from './throttle.ts';
import { Timekeeper } from './timekeeper.ts';
import type {
  ScheduledReport,
  ScheduledSend,
  SlottedJob,
} from './timekeeper.ts';
import { Timers } from './timers.ts';
import { Uuid } from './uuid.ts';
import { Worker } from './worker.ts';

export { DatabaseError } from './database-error.ts';
export { UnsupportedStartAfterError } from './start-after.ts';

export type { FoundJob, JobQueue, StartOptions } from './job-queue.ts';

function toError(value: unknown): Error {
  return Error.isError(value) ? value : new Error(String(value));
}

// pg-boss emits a spread copy of a worker's error, not the Error itself
// (node_modules/pg-boss/dist/manager.js:1297-1299): an Error's message, stack and
// name are non-enumerable, so the payload carries only the fields set here and
// is not `instanceof Error`.
function toWorkerEvent(error: Error, queue: string, workerId: string) {
  return spreadCopy(error, { queue, worker: workerId });
}

// pg-boss's spread copy of an error it emits (node_modules/pg-boss/dist/
// manager.js:1057).
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

export interface SqliteJobQueueOptions
  extends
    Pick<
      MaintenanceOptions,
      | 'supervise'
      | 'superviseIntervalSeconds'
      | 'monitorIntervalSeconds'
      | 'maintenanceIntervalSeconds'
      | 'queueCacheIntervalSeconds'
      | 'warningQueueSize'
    >,
    Pick<
      SchedulingOptions,
      | 'schedule'
      | 'cronMonitorIntervalSeconds'
      | 'cronWorkerIntervalSeconds'
      | 'clockMonitorIntervalSeconds'
    > {
  path?: string;
  database?: DatabaseSync;
  clock?: Clock;
  useListenNotify?: boolean;
}

// The database start() opened or the caller gave, or none.
type Connection = { kind: 'closed' } | { kind: 'open'; database: DatabaseSync };

type ManagerPhase =
  { kind: 'unstarted' } | { kind: 'started' } | { kind: 'stopped' };

type NotifierPhase = { kind: 'available' } | { kind: 'unavailable' };

// Where a pg_notify of this instance goes, from start() to stop(). A queue
// file: to each instance that listens on the file, through
// @zukhruf/sqlite-notify. A database in memory: no other program can open it,
// and sqlite-notify refuses it, so the wake stays in this instance (ADR 0007).
type NotifyRoute =
  | { kind: 'stopped' }
  | { kind: 'file'; notifications: Notifications }
  | { kind: 'memory' };

// pg-boss's channel: 'pgboss_' and the first 24 hex digits of the SHA-224 of
// the schema name (node_modules/pg-boss/dist/plans.js:1190-1192). The schema is
// pg-boss's default, 'pgboss' (plans.js:12); this package has no schema option.
const notifyChannel = `pgboss_${hash('sha224', 'pgboss', 'hex').slice(0, 24)}`;

// node_modules/pg-boss/dist/manager.js:151, 155
const QUEUE_STATS_CACHE_TTL_SECONDS = 60 * 60;
const QUEUE_STATS_FORCE_TTL_SECONDS = 60;

type LifecyclePhase =
  | { kind: 'stopped' }
  // A start in flight; stop() aborts `retry` to end its wait between attempts.
  | { kind: 'armed'; retry: AbortController }
  | { kind: 'running' };
// The clock attached to this instance's activity, from start() to stop().
type Attachment =
  { kind: 'detached' } | { kind: 'attached'; handle: AsyncDisposable };

function normalizeOptions(
  options?: string | SqliteJobQueueOptions,
): SqliteJobQueueOptions {
  if (typeof options === 'string' || options === undefined) {
    return { path: options ?? ':memory:' };
  }

  return { ...options, path: options.path ?? ':memory:' };
}

export class SqliteJobQueue
  extends EventEmitter<
    Pick<PgBossEventMap, 'error' | 'warning' | 'wip' | 'stopped'>
  >
  implements JobQueue
{
  // Like pg-boss (node_modules/pg-boss/dist/index.js:596-603): a `path` makes
  // the queue own its database, opened by start() and refusing SQL until then
  // (db.js:112); a caller-supplied `database` is used as is, like pg-boss's
  // `db` adapter, so SQL before start() fails on the missing schema.
  #connection: Connection;
  readonly #path: string;
  readonly #ownsDatabase: boolean;
  // pg-boss's manager #stopped, set in start() and stop(), so work() before
  // the first start() is allowed (node_modules/pg-boss/dist/
  // manager.js:1178-1180).
  #manager: ManagerPhase = { kind: 'unstarted' };
  readonly #clock: Clock;
  readonly #useListenNotify: boolean;
  // manager.js:228, 262: this instance's id, which a handler_overrun warning
  // names (12.38.0).
  readonly #instanceId = randomUUID();
  readonly #warnedFetchOptions = new Set<string>();
  // pg-boss's notifier.available (node_modules/pg-boss/dist/notifier.js:29):
  // this instance listens from start() to stop() when useListenNotify is on.
  #notifier: NotifierPhase = { kind: 'unavailable' };
  #notifyRoute: NotifyRoute = { kind: 'stopped' };
  // PgBoss's own #stopped and #started (node_modules/pg-boss/dist/
  // index.js:81, 153, 346): armed before a start runs, so stop() can shut
  // down what a start that threw partway left armed.
  #lifecycle: LifecyclePhase = { kind: 'stopped' };
  readonly #starting = new CurrentOperation<this>();
  readonly #stopping = new CurrentOperation<void>();
  readonly #activity = new Activity();
  #attachment: Attachment = { kind: 'detached' };
  // When wip last went out, first read at construction
  // (node_modules/pg-boss/dist/manager.js:248).
  #wipTs: number;
  #wipInterval: ClockTimer | undefined;
  readonly #queueCache = new QueueCache();
  readonly #queueCacheIntervalSeconds: number;
  readonly #intervals: SuperviseIntervals;
  #queueCacheInterval: ClockTimer | undefined;
  // The offWork() cleanups a stop waits for, each counted until it settles.
  readonly #pendingCleanups = new WaitGroup();
  readonly #localGroups = new LocalGroups();
  readonly #supervisor: Supervisor;
  // attorney.js:415
  readonly #schedule: boolean;
  readonly #timekeeper: Timekeeper;
  private readonly workers = new Map<string, Worker<JobRow>>();

  constructor(options?: string | SqliteJobQueueOptions) {
    super();
    const normalized = normalizeOptions(options);
    this.#connection =
      normalized.database === undefined
        ? { kind: 'closed' }
        : { kind: 'open', database: normalized.database };
    this.#path = normalized.path ?? ':memory:';
    this.#ownsDatabase = normalized.database === undefined;
    // node_modules/pg-boss/dist/attorney.js:422, 424, 429
    this.#clock = Attorney.applyClockConfig(normalized.clock);
    const intervals = Attorney.applyOpsConfig(normalized);
    const timekeeping = Attorney.applyScheduleConfig(normalized);
    Attorney.validateWarningConfig(normalized);
    this.#queueCacheIntervalSeconds = intervals.queueCacheIntervalSeconds;
    this.#intervals = intervals;
    this.#supervisor = new Supervisor(this.#clock, this.#activity, {
      ...intervals,
      // attorney.js:416
      supervise: 'supervise' in normalized ? normalized.supervise : true,
      warningQueueSize: normalized.warningQueueSize,
    });
    // index.js:112-113, 128-131
    this.#supervisor.on('error', (error) => this.emit('error', error));
    this.#supervisor.on('warning', (warning) => this.emit('warning', warning));
    this.#schedule = Boolean(
      'schedule' in normalized ? normalized.schedule : true,
    );
    this.#timekeeper = new Timekeeper(
      this.#clock,
      this.#activity,
      timekeeping,
      {
        createQueue: (name) => this.createQueue(name),
        work: (name, options, handler) => this.work(name, options, handler),
        offWork: (name, options) => this.offWork(name, options),
        send: (request) => this.#send([request]),
        insert: (name, jobs) => this.#insertSlotted(name, jobs),
        // manager.js:1692-1699 (12.39.0), resolved as send() resolves them;
        // the queue's defaults fill the rest at the insert, as for send().
        scheduledJobFields: (name, data, options) => {
          const request = Attorney.checkSendArgs([name, data ?? null, options]);
          return { data: request.data ?? null, options: request.options };
        },
        getQueueCache: (name) => this.getQueueOrThrow(name),
        sendScheduled: (sends) => this.#sendScheduled(sends),
      },
    );
    // index.js:114
    this.#timekeeper.on('error', (error) => this.emit('error', error));
    this.#timekeeper.on('warning', (warning) => this.emit('warning', warning));
    this.#wipTs = this.#clock.now();
    // node_modules/pg-boss/dist/attorney.js:419
    this.#useListenNotify = normalized.useListenNotify ?? false;
  }

  #now(): Date {
    return new Date(this.#clock.now());
  }

  private get db(): DatabaseSync {
    assert(
      this.#connection.kind === 'open',
      // db.js:112 (12.37.0)
      'Database not opened. Call start() before using pg-boss, or again after stop().',
    );
    return this.#connection.database;
  }

  // node_modules/pg-boss/dist/index.js:133-161: attempts is checked first
  // (12.37.0), a stop in flight finishes first, and a concurrent start shares
  // the one in flight.
  async start(options: StartOptions = {}): Promise<this> {
    const { attempts = 1 } = options;
    assert(
      Number.isInteger(attempts) && attempts >= 1,
      'start() attempts must be an integer of 1 or more',
    );
    const stopping = this.#stopping.inFlight;
    if (stopping) {
      await Promise.allSettled([stopping.wait()]);
    }
    const starting = this.#starting.inFlight;
    if (starting) {
      return starting.wait();
    }
    if (this.#lifecycle.kind === 'running') {
      return this;
    }
    const retry = new AbortController();
    this.#lifecycle = { kind: 'armed', retry };
    return this.#starting.run(this.#startAttempts(attempts, retry));
  }

  // index.js:162-197: each attempt is a start again after a failure. An
  // AssertionError is a configuration this cannot run, the same every time,
  // so it fails at once; any other failure waits 1 s, doubling up to 30 s,
  // on real time, as pg-boss's delay does, and warns on the first one only.
  async #startAttempts(
    attempts: number,
    retry: AbortController,
  ): Promise<this> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#doStart();
      } catch (error) {
        if (
          attempt >= attempts ||
          retry.signal.aborted ||
          error instanceof AssertionError
        ) {
          throw error;
        }
        const message = Error.isError(error) ? error.message : undefined;
        if (attempt === 1) {
          this.emit('warning', {
            message: `start() failed and will try again, up to ${attempts - 1} more times: ${message}`,
            data: { type: 'start_retry', attempts, error: message },
          });
        }
        await Timers.delay(
          systemClock,
          Math.min(2 ** (attempt - 1), 30) * 1000,
          undefined,
          retry,
        );
        if (retry.signal.aborted) {
          throw error;
        }
      }
    }
  }

  // index.js:199-237: the clock attaches once the schema exists and before
  // anything arms a timer.
  async #doStart(): Promise<this> {
    if (this.#connection.kind === 'closed') {
      this.#connection = {
        kind: 'open',
        // pg-boss on Postgres keeps each acknowledged job at a power loss, so
        // the queue file syncs each commit (ADR 0005).
        database: open(this.#path, {
          journal: new WriteAheadLog({ synchronous: 'full' }),
        }),
      };
    }
    Contractor.start(this.db);
    if (Activity.isAttachable(this.#clock)) {
      this.#attachment = {
        kind: 'attached',
        handle: await this.#activity.attach(this.#clock),
      };
    }
    this.#manager = { kind: 'started' };
    // manager.js:1028-1046: the cache refresh, then wip, both on the clock in
    // that order, then the cache's first load.
    this.#queueCacheInterval = this.#clock.setInterval(() => {
      void this.#onCacheQueues(true);
    }, this.#queueCacheIntervalSeconds * 1000);
    this.#wipInterval = this.#clock.setInterval(
      () => this.#onWipInterval(),
      2000,
    );
    await this.#onCacheQueues(false);
    this.#notifyRoute = this.#openNotifyRoute();
    if (this.#useListenNotify) {
      await this.#listen(this.#notifyRoute);
    }
    // index.js:225-230
    this.#supervisor.start(this.db);
    if (this.#schedule) {
      await this.#timekeeper.start(this.db);
    }
    this.#lifecycle = { kind: 'running' };
    return this;
  }

  #openNotifyRoute(): NotifyRoute {
    if (this.db.location() === null) {
      return { kind: 'memory' };
    }
    const clock = this.#clock;
    const notifications = new Notifications({
      database: this.db,
      clock: {
        setTimeout: (callback, ms) => clock.setTimeout(callback, ms),
        clearTimeout: (timer) => clock.clearTimeout(timer),
        performance: { now: () => clock.now() },
      },
    });
    // The notifier's errors are the instance's (index.js:117).
    notifications.on('error', (error) => this.emit('error', toError(error)));
    return { kind: 'file', notifications };
  }

  // notifier.js:52-71: a listener that cannot start leaves the workers on
  // their poll. Once it listens, each worker of a notify queue fetches, for
  // what was sent before (adapters/pglite.js:144-152, manager.js:1590-1598).
  async #listen(route: NotifyRoute): Promise<void> {
    if (route.kind === 'file') {
      route.notifications.on('notification', ({ payload }) =>
        this.notifyQueue(payload),
      );
      try {
        await route.notifications.listen(notifyChannel);
      } catch (error) {
        this.emit('warning', {
          message:
            'Failed to start LISTEN/NOTIFY listener. Continuing with polling only.',
          data: {
            type: 'listen_notify_unavailable',
            error: toError(error).message,
          },
        });
        return;
      }
    }
    this.#notifier = { kind: 'available' };
    await this.#activity.deliver(() => this.wakeNotifyQueueWorkers());
  }

  // The pg_notify(channel, queue name) of pg-boss's insert, in the insert's
  // transaction (plans.js:2991-3083).
  #notify(name: string): void {
    const route = this.#notifyRoute;
    if (route.kind === 'file') {
      route.notifications.notify(notifyChannel, name);
    } else if (route.kind === 'memory' && this.#notifier.kind === 'available') {
      // PGlite gives the NOTIFY as the insert runs (src/pglite.ts:980-992).
      this.notifyQueue(name);
    }
  }

  // node_modules/pg-boss/dist/index.js:259-363.
  async stop(options: StopOptions = {}): Promise<void> {
    // A start waiting between attempts stops trying, and fails now with its
    // last error (index.js:260-265).
    if (this.#lifecycle.kind === 'armed') {
      this.#lifecycle.retry.abort();
    }
    const starting = this.#starting.inFlight;
    if (starting) {
      await Promise.allSettled([starting.wait()]);
    }
    const stopping = this.#stopping.inFlight;
    if (stopping) {
      return stopping.wait();
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
    return this.#stopping.run(this.#doStop(close, graceful, timeout));
  }

  async #doStop(
    close: boolean,
    graceful: boolean,
    timeout: number,
  ): Promise<void> {
    // pg-boss closes its listener first, still listening through the close's
    // I/O (node_modules/pg-boss/dist/index.js:309, notifier.js:77-84), so a
    // fetch in flight lands before the workers stop and their group tracking
    // is cleared.
    if (this.#notifier.kind === 'available') {
      await this.#unlisten(this.#notifyRoute);
    }
    this.#notifier = { kind: 'unavailable' };
    // manager.js:1126-1141: refuse new work and let every worker wind down.
    this.#manager = { kind: 'stopped' };
    this.#clock.clearInterval(this.#queueCacheInterval);
    this.#clock.clearInterval(this.#wipInterval);
    // The send-it worker is the timekeeper's to stop (manager.js:1133-1135).
    const names = new Set(
      Array.from(this.workers.values(), (w) => w.name).filter(
        (name) => name !== Timekeeper.sendIt,
      ),
    );
    await Promise.allSettled(
      Array.from(names, (name) => this.offWork(name, { wait: false })),
    );
    this.#localGroups.clear();
    // index.js:311-314
    await this.#timekeeper.stop();
    await this.#supervisor.stop();
    // pg-boss's later stops do no I/O before failWip (index.js:309-321), so a
    // claim still restoring its excess lands after failWip and is refused
    // (traced on 12.38.2: the restore settles after failWip starts).
    const shutdown = async () => {
      await this.#failWip();
      await this.#closeNotifyRoute();
      const attachment = this.#attachment;
      this.#attachment = { kind: 'detached' };
      if (attachment.kind === 'attached') {
        await attachment.handle[Symbol.asyncDispose]();
      }
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
    // The system clock of pg-boss, not the configured clock: the deadline
    // bounds shutdown, and under a test clock nothing would tick it while
    // stop() waits. pg-boss runs this deadline on the real timers too.
    let deadlineTimer: ClockTimer | undefined;
    const deadline = new Promise<void>((resolve) => {
      deadlineTimer = systemClock.setTimeout(resolve, timeout);
    });
    try {
      // manager.js:1420-1426: waits until no worker is still stopping.
      await Promise.race([
        this.#pendingCleanups.wait({ signal: undefined }),
        deadline,
      ]);
    } finally {
      systemClock.clearTimeout(deadlineTimer);
    }
    await shutdown();
  }

  // notifier.js:77-84: a close that fails goes to the error event.
  async #unlisten(route: NotifyRoute): Promise<void> {
    if (route.kind !== 'file') {
      await setImmediate();
      return;
    }
    try {
      await route.notifications.unlisten(notifyChannel);
    } catch (error) {
      this.emit('error', toError(error));
    }
  }

  async #closeNotifyRoute(): Promise<void> {
    const route = this.#notifyRoute;
    this.#notifyRoute = { kind: 'stopped' };
    if (route.kind === 'file') {
      await route.notifications[Symbol.asyncDispose]();
    }
  }

  #closeOwnDatabase(): void {
    if (this.#ownsDatabase && this.#connection.kind === 'open') {
      this.#connection.database.close();
      this.#connection = { kind: 'closed' };
    }
  }

  // manager.js:1145-1175: fail each worker's batch, then abandon it. A failure
  // is reported rather than thrown, so every worker is still reached.
  async #failWip(): Promise<void> {
    // Every worker first, so a batch landing on a later worker while an
    // earlier one's fail runs is refused too (manager.js:1147-1151).
    for (const worker of this.workers.values()) {
      worker.expireGrace();
    }
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
          } catch (thrown) {
            // The remaining workers still have to be reached, and nothing is
            // left to tell: an error event nobody listens for throws
            // ERR_UNHANDLED_ERROR back out of emit(), here or from an emitter
            // that re-emits it, and a listener that throws has no caller.
            // Either is a process warning, of the worker's own error when
            // nobody listened.
            const unheard =
              Error.isError(thrown) &&
              'code' in thrown &&
              thrown.code === 'ERR_UNHANDLED_ERROR';
            const detail = `queue: ${worker.name}\nworker: ${worker.id}`;
            if (unheard)
              process.emitWarning(
                Object.assign(
                  new Error(
                    `The fail of a worker's active jobs at stop failed, and nobody listens for 'error': ${Error.isError(error) ? error.message : String(error)}`,
                    { cause: error },
                  ),
                  {
                    name: 'SqliteJobQueueWarning',
                    code: 'ZUKHRUF_SQLITE_QUEUE_STOP_FAIL_UNHEARD',
                    detail,
                  },
                ),
              );
            else
              process.emitWarning(
                Object.assign(
                  new Error(
                    `The fail of a worker's active jobs at stop failed, and an 'error' listener threw: ${Error.isError(thrown) ? thrown.message : String(thrown)}`,
                    { cause: thrown },
                  ),
                  {
                    name: 'SqliteJobQueueWarning',
                    code: 'ZUKHRUF_SQLITE_QUEUE_ERROR_LISTENER_THREW',
                    detail,
                  },
                ),
              );
          }
        }
      }
      worker.abort();
    }
  }

  // manager.js:1049-1059: a refresh that fails keeps the cache it had, and only
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

  // manager.js:1036-1045: while a worker holds jobs, at least 2000 ms apart.
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

  // manager.js:1399-1407: before and after each batch, strictly more than
  // 2000 ms apart, except the send-it worker's.
  #emitWip(name: string): void {
    if (name === Timekeeper.sendIt) {
      return;
    }
    const now = this.#clock.now();
    if (now - this.#wipTs > 2000) {
      this.emit('wip', this.#getWipData());
      this.#wipTs = now;
    }
  }

  // manager.js:1408-1413: the send-it worker is internal.
  #getWipData(): WipData[] {
    return Array.from(this.workers.values(), (worker) =>
      worker.toWipData(),
    ).filter(
      (worker) =>
        worker.state !== 'stopped' && worker.name !== Timekeeper.sendIt,
    );
  }

  // manager.js:1427-1457: stops the queue's workers, or one work() call's
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
      const pending = this.#pendingCleanups.add();
      void cleanup.then(() => {
        pending[Symbol.dispose]();
        this.#forgetLocalGroups(name);
      });
    }
  }

  // manager.js:545-552: a queue's group tracking goes with its last worker
  // neither stopping nor stopped.
  #forgetLocalGroups(name: string): void {
    const live = this.workers
      .values()
      .some(
        (worker) => worker.name === name && !worker.stopping && !worker.stopped,
      );
    if (!live) {
      this.#localGroups.forget(name);
    }
  }

  async createQueue(
    name: string,
    options: Omit<Queue, 'name'> = {},
  ): Promise<void> {
    // node_modules/pg-boss/dist/manager.js:2625-2633. `partition` is a pg-boss
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
    this.#reloadQueueCache(name);
  }

  async updateQueue(
    name: string,
    options: UpdateQueueOptions = {},
  ): Promise<void> {
    // pg-boss counts keys, not defined values, rejects the two settings fixed
    // at creation, then validates every key present
    // (node_modules/pg-boss/dist/manager.js:2679-2687).
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
    // (manager.js:2688-2694).
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
    this.#reloadQueueCache(name);
  }

  // #reloadQueueCache (manager.js:1116-1126): the entry becomes the queue's row
  // as it stands, so a queue created again or updated picks up what changed.
  #reloadQueueCache(name: string): void {
    const queue = this.findQueue(name);
    if (queue === undefined) {
      this.#queueCache.evict(name);
    } else {
      this.#queueCache.reload(queue);
    }
  }

  // A dead letter queue still in use is refused before any job is deleted,
  // naming another queue that uses it, else another queue's job; the queue's
  // own jobs go first (node_modules/pg-boss/dist/manager.js:2703-2726,
  // plans.js:1202-1209). One transaction, so no reference lands between the
  // check and the delete.
  async deleteQueue(name: string): Promise<void> {
    Attorney.assertQueueName(name);
    transaction(
      this.db,
      () => {
        const referrer = this.db
          .prepare(
            `SELECT * FROM (SELECT name, 'queue' AS kind FROM pgboss_queue
              WHERE dead_letter = ?1 AND name <> ?1 LIMIT 1)
            UNION ALL
            SELECT * FROM (SELECT queue_name, 'job' FROM pgboss_job
              WHERE dead_letter = ?1 AND queue_name <> ?1 LIMIT 1)
            LIMIT 1`,
          )
          .get(name);
        if (referrer !== undefined) {
          const user = Row.readString(referrer, 'name');
          throw new Error(
            Row.readString(referrer, 'kind') === 'queue'
              ? `Queue ${name} was not deleted: queue ${user} uses it as its dead letter queue`
              : `Queue ${name} was not deleted: jobs in queue ${user} name it as their dead letter queue`,
          );
        }
        this.db
          .prepare('DELETE FROM pgboss_job WHERE queue_name = ?')
          .run(name);
        this.db.prepare('DELETE FROM pgboss_queue WHERE name = ?').run(name);
      },
      { mode: 'immediate' },
    );
    this.#queueCache.evict(name);
  }

  // node_modules/pg-boss/dist/manager.js:2815-2933 with persistQueueStats off,
  // the only mode here: SqliteJobQueueOptions has no persistQueueStats, so the
  // history options are neither read nor checked (2871-2891). pg-boss's
  // vacuum backoff (2916-2918) has no counterpart (see Supervisor).
  async getQueueStats(
    name: string,
    options: QueueStatsOptions = {},
  ): Promise<QueueStats[]> {
    Attorney.assertQueueName(name);
    // manager.js:2817-2820 (12.36.0): each percent once, in the order first
    // asked for.
    const requested: unknown = options.percentiles;
    assert(
      requested === undefined ||
        (Array.isArray(requested) &&
          requested.length > 0 &&
          requested.every(
            (p: unknown) => typeof p === 'number' && p >= 1 && p <= 100,
          )),
      'getQueueStats: percentiles must be a non-empty array of percents from 1 to 100, such as [50, 95]',
    );
    const percentiles =
      requested === undefined ? undefined : [...new Set<number>(requested)];
    const cached = QueueStatsCache.read(this.db, name);
    if (!cached) {
      throw new Error(`Queue ${name} does not exist`);
    }
    const maxCacheAgeMs =
      (options.force
        ? QUEUE_STATS_FORCE_TTL_SECONDS
        : Math.max(
            QUEUE_STATS_CACHE_TTL_SECONDS,
            this.#intervals.monitorIntervalSeconds,
            this.#intervals.superviseIntervalSeconds,
          )) * 1000;
    // A queue never counted has an infinite cache age (manager.js:2906).
    const { capturedOn } = cached;
    if (
      capturedOn !== null &&
      this.#clock.now() - capturedOn.getTime() <= maxCacheAgeMs
    ) {
      return [
        SqliteJobQueue.#toQueueStats(
          name,
          { ...cached, capturedOn },
          percentiles,
        ),
      ];
    }
    // SQLite has one writer, so the refresh cannot lose pg-boss's try-lock to
    // another instance's scan and fall back to the cache (manager.js:
    // 2718-2728): it always counts the queue and returns its row.
    return QueueStatsCache.refresh(this.db, [name], this.#now()).map((row) =>
      SqliteJobQueue.#toQueueStats(name, row, percentiles),
    );
  }

  // toSnapshot (manager.js:2824-2870) of the cache, which holds gauges only:
  // with persistQueueStats off pg-boss counts nothing more (its cache and
  // refresh paths, :2711-2728, read uncounted), so the deltas, the wait and
  // run histograms and readyOldestSeconds (12.36.0) stay null.
  static #toQueueStats(
    name: string,
    cached: CachedQueueStats & { capturedOn: Date },
    percentiles: number[] | undefined,
  ): QueueStats {
    const snapshot: QueueStats = {
      name,
      deferredCount: cached.deferredCount,
      queuedCount: cached.queuedCount,
      readyCount: cached.readyCount,
      activeCount: cached.activeCount,
      failedCount: cached.failedCount,
      totalCount: cached.totalCount,
      completedDelta: null,
      failedDelta: null,
      createdDelta: null,
      deltaSeconds: null,
      deltaOn: null,
      waitBins: null,
      runBins: null,
      readyOldestSeconds: null,
      capturedOn: cached.capturedOn,
    };
    // Read from the snapshot's histograms, which are null here
    // (manager.js:2863-2869).
    if (percentiles) {
      snapshot.percentiles = percentiles.map((p) => ({
        p,
        waitSeconds: null,
        runSeconds: null,
      }));
    }
    return snapshot;
  }

  send(request: Request): Promise<string | null>;
  send<TData extends object>(
    name: string,
    data?: TData | null,
    options?: SendOptions,
  ): Promise<string | null>;
  // node_modules/pg-boss/dist/manager.js:1639-1642, 1717-1747.
  async send(...args: unknown[]): Promise<string | null> {
    return this.#send(args);
  }

  async #send(args: unknown[]): Promise<string | null> {
    const { name, data, options } = Attorney.checkSendArgs(args);
    // The insert is a statement like a fetch's claim: it runs when issued
    // and its outcome comes back over I/O.
    return this.#activity.query(() => {
      const queue = this.getQueueOrThrow(name);
      // node_modules/pg-boss/dist/manager.js:1726-1728
      if (queue.policy === policies.key_strict_fifo && !options.singletonKey) {
        throw new Error(
          `${policies.key_strict_fifo} queues require a singletonKey`,
        );
      }
      // pg-boss sends the job as one JSON text that json_to_recordset reads
      // (manager.js:1730, plans.js:2979), so the first escape no field can
      // hold refuses the send, whichever field holds it.
      Jsonb.assertEscapes(JobRows.payload(queue.name, data, options));
      const now = this.#now();
      try {
        return this.#sendInTransaction(queue, data, options, now);
      } catch (error) {
        // The insert's division_by_zero, here a throttle slot of no width,
        // is pg-boss's write error (12.37.0: manager.js:171-177, 1730).
        if (error instanceof DatabaseError && error.code === '22012') {
          throw new Error(
            'one or more jobs could not be created. This usually means a job id was duplicated, collided with an existing job, or was rejected by a queue policy (short, singleton, stately, or exclusive).',
            { cause: error },
          );
        }
        throw error;
      }
    });
  }

  #sendInTransaction(
    queue: QueueRow,
    data: unknown,
    options: SendOptions,
    now: Date,
  ): string | null {
    return transaction(
      this.db,
      () => {
        const stored =
          this.#insertJob(queue.name, data, options, queue, now, {
            startAfter: options.startAfter,
            singletonOn: Throttle.slot(options.singletonSeconds, 0, now),
          }) ??
          // manager.js:1742-1745: a send a unique index refused retries once
          // into the next throttle slot, starting when that slot does.
          (options.singletonNextSlot
            ? this.#insertJob(queue.name, data, options, queue, now, {
                startAfter: Throttle.debounceStartAfter(
                  options.singletonSeconds,
                  now,
                ),
                singletonOn: Throttle.slot(
                  options.singletonSeconds,
                  options.singletonSeconds,
                  now,
                ),
              })
            : null);
        if (stored === null) {
          return null;
        }
        // A notify queue's insert notifies when the stored job is due now,
        // whether or not this instance listens (node_modules/pg-boss/dist/
        // plans.js:2991-3083, manager.js:1578-1580, 1729).
        if (queue.notify && stored.startAfter <= SqlValues.asIso(now)) {
          this.#notify(queue.name);
        }
        return stored.id;
      },
      { mode: 'immediate' },
    );
  }

  // manager.js:1870-1955 with __singletonSlots, the cron pass's own insert:
  // each job names the throttle slot it is filed in, and one a unique index
  // refuses is skipped (plans.js:2879, 2985). One statement for the batch.
  async #insertSlotted(name: string, jobs: SlottedJob[]): Promise<void> {
    await this.#activity.query(() => {
      const queue = this.getQueueOrThrow(name);
      const now = this.#now();
      transaction(
        this.db,
        () => {
          const stored = jobs.map((job) =>
            this.#insertJob(
              queue.name,
              job.data,
              { singletonKey: job.singletonKey },
              queue,
              now,
              { startAfter: undefined, singletonOn: job.singletonOn },
            ),
          );
          // One pg_notify when an inserted job is due now (plans.js:2999-3003).
          if (
            queue.notify &&
            stored.some(
              (job) => job !== null && job.startAfter <= SqlValues.asIso(now),
            )
          ) {
            this.#notify(queue.name);
          }
        },
        { mode: 'immediate' },
      );
    });
  }

  // sendScheduledJobs and sendScheduled (12.39.0: plans.js:3006-3083,
  // manager.js:1700-1716): each schedule matched on the definition it was
  // read under, its cursor moved to `through` by a compare-and-set on the
  // value read, and only then its occurrences after that value inserted, as
  // send() inserts a job. One IMMEDIATE transaction holds the write lock from
  // the read to the last insert, so no other writer runs between them, where
  // Postgres needs the UPDATE to re-check the row once a racing writer
  // commits; the compare on sent_on stays as pg-boss writes it. A schedule
  // that matches nothing has no row in the report.
  async #sendScheduled(sends: ScheduledSend[]): Promise<ScheduledReport[]> {
    return this.#activity.query(() => {
      const now = this.#now();
      return transaction(
        this.db,
        () => {
          const report: ScheduledReport[] = [];
          const inserts: Array<{
            queue: QueueRow;
            data: unknown;
            options: SendOptions;
          }> = [];
          for (const send of sends) {
            const matched = this.db
              .prepare(
                `SELECT sent_on FROM pgboss_schedule
                WHERE queue_name = ? AND key = ? AND cron = ?
                  AND COALESCE(timezone, 'UTC') = ?
                  AND data IS ? AND options IS ?`,
              )
              .get(
                send.name,
                send.key,
                send.cron,
                send.timezone,
                send.data,
                send.options,
              );
            if (matched === undefined) {
              continue;
            }
            const prev = Row.readNullableString(
              Row.parse(matched, 'schedule'),
              'sent_on',
            );
            const prevTime = prev === null ? null : Date.parse(prev);
            const claimed =
              (prevTime === null || prevTime < send.through.getTime()) &&
              this.db
                .prepare(
                  `UPDATE pgboss_schedule SET sent_on = ?
                  WHERE queue_name = ? AND key = ? AND sent_on IS ?`,
                )
                .run(SqlValues.asIso(send.through), send.name, send.key, prev)
                .changes > 0;
            report.push({ name: send.name, key: send.key, prev, claimed });
            if (!claimed) {
              continue;
            }
            const queue = this.getQueueOrThrow(send.name);
            for (const occurrence of send.occurrences) {
              if (prevTime === null || occurrence.getTime() > prevTime) {
                inserts.push({
                  queue,
                  data: send.job.data,
                  options: { ...send.job.options, id: randomUUID() },
                });
              }
            }
          }
          // plans.js:3043: in queue and singletonKey order, nulls last.
          inserts.sort((a, b) => {
            if (a.queue.name !== b.queue.name) {
              return a.queue.name < b.queue.name ? -1 : 1;
            }
            const x = a.options.singletonKey ?? null;
            const y = b.options.singletonKey ?? null;
            if (x === y) {
              return 0;
            }
            if (x === null || y === null) {
              return x === null ? 1 : -1;
            }
            return x < y ? -1 : 1;
          });
          const notified = new Set<string>();
          for (const { queue, data, options } of inserts) {
            Jsonb.assertEscapes(JobRows.payload(queue.name, data, options));
            const stored = this.#insertJob(
              queue.name,
              data,
              options,
              queue,
              now,
              {
                startAfter: options.startAfter,
                singletonOn: Throttle.slot(options.singletonSeconds, 0, now),
              },
            );
            // plans.js:3047-3052
            if (
              queue.notify &&
              stored !== null &&
              stored.startAfter <= SqlValues.asIso(now)
            ) {
              notified.add(queue.name);
            }
          }
          for (const name of notified) {
            this.#notify(name);
          }
          return report;
        },
        { mode: 'immediate' },
      );
    });
  }

  // One insert, returning the stored id and start_after; null when a unique
  // index (policy or throttle) refuses it, like pg-boss's ON CONFLICT DO
  // NOTHING (plans.js:2985).
  #insertJob(
    name: string,
    data: unknown,
    options: SendOptions,
    queue: QueueRow,
    now: Date,
    attempt: {
      startAfter: SendOptions['startAfter'];
      singletonOn: string | null;
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
          // JSON cannot hold drops to null (manager.js:1730).
          JSON.stringify(data) ?? 'null',
          queue.policy,
          options.priority ?? 0,
          options.retryLimit ?? queue.retry_limit,
          options.retryDelay ?? queue.retry_delay_seconds,
          SqlValues.toSqlBool(options.retryBackoff) ?? queue.retry_backoff,
          options.retryDelayMax ?? queue.retry_delay_max_seconds,
          SqlValues.asIso(startAfter),
          options.singletonKey ?? null,
          attempt.singletonOn,
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
      // letter queue's (plans.js:1251-1254), which pg-boss names
      // (manager.js:1102-1104).
      if (Database.isForeignKeyViolation(error)) {
        throw new Error(
          `Dead letter queue ${options.deadLetter ?? queue.dead_letter} does not exist`,
          { cause: error },
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
    // (node_modules/pg-boss/dist/manager.js:1176-1180).
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
    // attorney.js:371, manager.js:1177-1181).
    const workerOptions = {
      ...options,
      pollingInterval,
      notifyPollingInterval,
    };

    // node_modules/pg-boss/dist/manager.js:1181-1333. Read once, as pg-boss
    // destructures them here (1181).
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
    // transaction (manager.js:1185-1186); SQLite's connection never can, so it
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
    // (manager.js:1061-1075, 1206), so choosing the wait does no I/O that could
    // fail outside the loop's catch.
    let queueNotifies = false;
    // The wait before each fetch: none after a full batch while the cached
    // ready count exceeds burstWhenReadyExceeds or when burstWhenBatchFull
    // asks (ignored at batchSize 1, where every fetch is full), the notify
    // backstop while this process hears the queue's notifications, else the
    // base poll (manager.js:1204-1225). The ready count is the monitor's, as the
    // cache last read it, and 0 for a queue it holds no entry for (1208).
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
        // before its first fetch lands (manager.js:2099-2101).
        fetch: () => {
          // Read as the fetch starts, before its I/O (manager.js:1227-1231).
          const ignoreGroups =
            localGroupConcurrency == null
              ? undefined
              : this.#localGroups.atCapacity(name);
          return this.#activity.query(() => {
            this.#warnDeprecatedFetchOptions({ priority, orderByCreatedOn });
            queueNotifies = false;
            // pg-boss checks the queue on every fetch, not when work()
            // registers (node_modules/pg-boss/dist/manager.js:1060-1072).
            const queue = this.getQueueOrThrow(name);
            queueNotifies = queue.notify;
            return JobFetcher.claim(
              this.db,
              queue,
              {
                batchSize,
                // work() never forwards it (manager.js:1227-1252).
                ignoreStartAfter: false,
                minPriority,
                maxPriority,
                groupConcurrency,
                ignoreGroups,
              },
              this.#now(),
            );
          });
        },
        onFetch: async (rows) => {
          if (rows.length === 0) {
            return;
          }
          this.#emitWip(name);
          // A handler a stop abandoned while it overran (12.38.0).
          const overrun: { abandoned: Promise<unknown> | null } = {
            abandoned: null,
          };
          const run = (jobs: JobRow[]) =>
            this.processJobs(
              name,
              jobs,
              handler,
              includeMetadata,
              worker,
              heartbeatRefreshSeconds,
              perJobResults,
              overrun,
            );
          if (localGroupConcurrency == null) {
            await run(rows);
          } else {
            // manager.js:1266-1293: the jobs over their group's local limit go
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
              // A handler a stop abandoned still runs, so its group slots
              // stay taken until it settles (manager.js:1279-1292).
              const end = () => this.#localGroups.end(name, grouped);
              if (overrun.abandoned) {
                overrun.abandoned.then(end, end);
              } else {
                end();
              }
            }
          }
          this.#emitWip(name);
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

  fetch(
    name: string,
    options: FetchOptions & { includeMetadata: true },
  ): Promise<JobWithMetadata<unknown>[]>;
  fetch(name: string, options?: FetchOptions): Promise<Job<unknown>[]>;
  // node_modules/pg-boss/dist/manager.js:2081-2180, without options.db, which
  // is a Postgres connection.
  async fetch(name: string, options: FetchOptions = {}) {
    Attorney.checkFetchArgs(name, options);
    this.#warnDeprecatedFetchOptions(options);
    const {
      batchSize,
      includeMetadata,
      ignoreStartAfter = false,
      minPriority,
      maxPriority,
      groupConcurrency,
      ignoreGroups,
    } = options;
    const rows = await this.#activity.query(() => {
      const queue = this.getQueueOrThrow(name);
      return JobFetcher.claim(
        this.db,
        queue,
        {
          batchSize: batchSize || 1,
          ignoreStartAfter,
          minPriority,
          maxPriority,
          groupConcurrency,
          ignoreGroups: ignoreGroups ?? undefined,
        },
        this.#now(),
      );
    });
    return rows.map((row) => JobRows.toFetched(row, includeMetadata ?? false));
  }

  async findJobs(
    name: string,
    options: FindJobsOptions = {},
  ): Promise<FoundJob<unknown>[]> {
    Attorney.assertQueueName(name);
    // manager.js:2947-2974 (12.38.0): the page's limit and anchor are checked
    // before the queue is looked up.
    const limit = Attorney.assertListLimit('findJobs', options.limit);
    const after: unknown = options.after;
    Attorney.assertListAfter('findJobs', after, true);
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

    // A job deleted since the previous page would otherwise end the list
    // early without saying so (manager.js:2966-2971, plans.js:4793-4798).
    if (typeof after === 'string') {
      const id = Uuid.canonical(after);
      const anchor = this.db
        .prepare(
          'SELECT created_on FROM pgboss_job WHERE queue_name = ? AND id = ?',
        )
        .get(name, id);
      assert(anchor, 'findJobs: after names a row that no longer exists');
      where.push('(created_on, id) > (?, ?)');
      values.push(Row.readString(anchor, 'created_on'), id);
    }

    // The data filter runs here, not in SQL, so the limit follows it.
    const rows = this.db
      .prepare(
        `SELECT * FROM pgboss_job
        WHERE ${where.join(' AND ')}
        ORDER BY created_on, id
        ${options.data === undefined ? 'LIMIT ?' : ''}`,
      )
      .all(...values, ...(options.data === undefined ? [limit] : []))
      .map(JobRows.decode);

    const filteredRows =
      options.data === undefined
        ? rows
        : rows
            .filter((row) => Jsonb.contains(JSON.parse(row.data), options.data))
            .slice(0, limit);

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

  // node_modules/pg-boss/dist/manager.js:2224-2246
  async complete(
    name: string,
    id: string | string[] | JobAttempt | JobAttempt[],
    data?: object | null,
    options: CompleteOptions = {},
  ) {
    Attorney.assertQueueName(name);
    const { ids, attempts } = Attorney.mapAttemptArg(id, 'complete');
    this.getQueueOrThrow(name);

    return JobSettler.response(
      ids,
      JobSettler.complete(
        this.db,
        name,
        ids,
        attempts,
        data,
        Boolean(options.includeQueued),
        this.#now(),
      ),
    );
  }

  // node_modules/pg-boss/dist/manager.js:2614-2622
  async touch(name: string, id: string | string[] | JobAttempt | JobAttempt[]) {
    Attorney.assertQueueName(name);
    const { ids, attempts } = Attorney.mapAttemptArg(id, 'touch');
    this.getQueueOrThrow(name);

    return JobSettler.response(
      ids,
      JobSettler.touch(this.db, name, ids, attempts, this.#now()),
    );
  }

  async fail(
    name: string,
    id: string | string[] | JobAttempt | JobAttempt[],
    data?: unknown,
  ) {
    Attorney.assertQueueName(name);
    const { ids, attempts } = Attorney.mapAttemptArg(id, 'fail');
    this.getQueueOrThrow(name);

    return JobSettler.response(
      ids,
      JobSettler.fail(this.db, name, ids, data, attempts, this.#now()),
    );
  }

  // node_modules/pg-boss/dist/timekeeper.js:1292-1333. db comes out first, so
  // the stored options never hold a connection (12.37.0, #946); this queue
  // takes no connection of the caller's (README).
  async schedule<TData extends object>(
    name: string,
    cron: string,
    data?: TData | null,
    options: ScheduleOptions = {},
  ): Promise<void> {
    const { db, ...persisted } = options;
    // timekeeper.js:1296-1299 (12.39.0): missed and precision tell the pass
    // what it owes and how finely to send, and are no send options.
    const { tz: requestedTz, key = '', missed, precision, ...rest } = persisted;
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
    // timekeeper.js:1323-1325 (12.39.0): the cron statement inserts each
    // occurrence once, where send() would try the next slot.
    Recurrence.assertPrecision(precision);
    assert(
      !(precision === schedulePrecisions.second && rest.singletonNextSlot),
      "singletonNextSlot is not supported with precision: 'second'",
    );
    try {
      // plans.js:1807-1827 (12.39.0): a new row, or a new expression, zone or
      // precision, starts sent_on now, since nothing before it is owed under
      // that definition; any other rewrite keeps its place. options->>'precision'
      // is json_extract here.
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
            created_on,
            updated_on,
            sent_on
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(queue_name, key) DO UPDATE SET
            kind = excluded.kind,
            cron = excluded.cron,
            timezone = excluded.timezone,
            data = excluded.data,
            options = excluded.options,
            updated_on = excluded.updated_on,
            sent_on = CASE
              WHEN pgboss_schedule.cron = excluded.cron
                AND COALESCE(pgboss_schedule.timezone, 'UTC') = COALESCE(excluded.timezone, 'UTC')
                AND COALESCE(json_extract(pgboss_schedule.options, '$.precision'), '${schedulePrecisions.minute}')
                  = COALESCE(json_extract(excluded.options, '$.precision'), '${schedulePrecisions.minute}')
              THEN pgboss_schedule.sent_on
              ELSE excluded.sent_on
            END`,
        )
        .run(
          name,
          SqlValues.text(key),
          kind,
          SqlValues.text(cron),
          tz,
          data == null ? null : Jsonb.parameter(data),
          Jsonb.parameter(options),
          SqlValues.asIso(now),
          SqlValues.asIso(now),
          SqlValues.asIso(now),
        );
    } catch (error) {
      // timekeeper.js:1331-1334 names the queue a refused reference points
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

  // timekeeper.js:1337-1340, plans.js:1830-1836
  async unschedule(name: string, key = ''): Promise<void> {
    this.db
      .prepare(
        `DELETE FROM pgboss_schedule
        WHERE queue_name = ? AND key = ?`,
      )
      .run(SqlValues.text(name), SqlValues.text(key));
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
  // plans.js:1588-1590, 1594-1597, 1601): a null keeps the stored value, as
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

  // CASE WHEN (o.data -> key) IS NOT NULL (plans.js:1591-1593, 1598-1600,
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
  // the name first and fills the cache, and codes a missing queue
  // (node_modules/pg-boss/dist/manager.js:23, 1060-1072).
  private getQueueOrThrow(name: unknown): QueueRow {
    Attorney.assertQueueName(name);
    const queue = this.findQueue(name);
    if (!queue) {
      throw Object.assign(new Error(`Queue ${name} does not exist`), {
        code: 'PGBOSS_QUEUE_NOT_FOUND',
      });
    }
    this.#queueCache.fill(queue);
    return queue;
  }

  // A DeprecationWarning, not a queue event, once per option per instance and
  // only when the option is set to false (node_modules/pg-boss/dist/
  // manager.js:161-167, 2073-2080).
  #warnDeprecatedFetchOptions(options: {
    priority?: boolean | undefined;
    orderByCreatedOn?: boolean | undefined;
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
  // 1413-1419).
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
  // manager.js:1590-1598).
  private wakeNotifyQueueWorkers(): void {
    for (const worker of this.workers.values()) {
      if (this.findQueue(worker.name)?.notify) {
        worker.notify();
      }
    }
  }

  // node_modules/pg-boss/dist/manager.js:596-774, without transactions, which
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
    overrun: { abandoned: Promise<unknown> | null },
  ): Promise<void> {
    const ids = rows.map((row) => row.id);
    // work() settles with the jobs it claimed, fenced to their attempts
    // (manager.js:725, 750).
    const attempts = rows.map((row) => row.retry_count);
    const maxExpiration = rows.reduce(
      (max, row) => Math.max(max, row.expire_seconds),
      0,
    );
    const batch = new AbortController();
    worker.abortController = batch;
    const claimed = rows.map((row) => ({ row, claim: new AbortController() }));
    // manager.js:612-613: the batch's signal or the job's own claim.
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
    // The handler's own promise: the timeout stops the wait for it, not the
    // handler (manager.js:665, 698-702).
    let handling: Promise<unknown> | null = null;
    let handlerSettled = false;
    try {
      try {
        // A fetch can land after stop() has spent its grace for running
        // handlers (manager.js:694-696).
        if (worker.graceExpired) {
          throw new Error('pg-boss shut down before the handler started');
        }
        handling = Promise.resolve(handler(jobs));
        handling.then(
          () => {
            handlerSettled = true;
          },
          () => {
            handlerSettled = true;
          },
        );
        const result = await Timers.resolveWithinSeconds(
          this.#clock,
          handling,
          maxExpiration,
          `handler execution exceeded ${maxExpiration}s`,
          batch,
        );
        if (perJobResults) {
          this.#settlePerJob(name, rows, result);
        } else {
          // The result is stored only for a batch of one (manager.js:725).
          this.#settle(name, () =>
            JobSettler.complete(
              this.db,
              name,
              ids,
              attempts,
              ids.length === 1 ? result : undefined,
              false,
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
    } finally {
      // Still running after its batch was failed: the worker waits for it,
      // even when that fail threw (manager.js:761-773).
      if (handling !== null && !handlerSettled) {
        await this.#awaitHandlerOverrun(
          name,
          ids,
          maxExpiration,
          handling,
          worker,
        );
        if (!handlerSettled) {
          overrun.abandoned = handling;
        }
      }
    }
  }

  // manager.js:792-822 (12.38.0): a handler that ignores job.signal is still
  // running after its batch was failed. Holding the worker until it returns
  // keeps localConcurrency and localGroupConcurrency a bound on the handlers
  // actually running, and keeps the worker from fetching a retry of the same
  // job beside it. Stopping the worker ends the wait: a stopping worker
  // fetches nothing, so there is nothing left to hold.
  async #awaitHandlerOverrun(
    name: string,
    jobIds: string[],
    expireInSeconds: number,
    handling: Promise<unknown>,
    worker: Worker<JobRow>,
  ): Promise<void> {
    const ended = worker.stopSignal;
    if (ended.aborted) {
      return;
    }
    // Its jobs were failed, and a retry may already be another worker's, so
    // they are no longer this worker's: its wip counts none, and a shutdown
    // has none of its to fail.
    worker.jobs = [];
    this.emit('warning', {
      message: `a handler on queue ${name} is still running after exceeding ${expireInSeconds}s. Its jobs were failed and their signals aborted, and this worker fetches nothing until it returns. Stop the handler on job.signal.`,
      data: {
        type: 'handler_overrun',
        instance: this.#instanceId,
        queue: name,
        jobs: jobIds,
        expireInSeconds,
      },
    });
    const over = Promise.withResolvers<void>();
    const onEnded = () => over.resolve();
    ended.addEventListener('abort', onEnded, { once: true });
    handling.then(onEnded, onEnded);
    try {
      await over.promise;
    } finally {
      ended.removeEventListener('abort', onEnded);
    }
  }

  // manager.js:426-485: the handler's results settle each job of the batch.
  // Entries without an id and status, naming no job of the batch by its exact
  // id, or carrying another status are ignored, the last valid entry per job
  // wins, and a job without one fails. The completed, failed and dead-lettered jobs then
  // settle in that order, each group on its own (466-476), so a group that
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
    // An empty group runs no statement (manager.js:468-476).
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
  // fail(), restore() and per-job settles do (manager.js:491, 510, 2230,
  // 2067, 2395), so a queue deleted under a running batch makes the settle
  // throw.
  #settle<T>(name: string, write: () => T): T {
    this.getQueueOrThrow(name);
    return write();
  }

  // manager.js:603-648: every heartbeatRefreshSeconds, or half the batch's
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
        refreshed = new Set(
          JobSettler.touch(
            this.db,
            name,
            held.map(({ row }) => row.id),
            held.map(({ row }) => row.retry_count),
            this.#now(),
          ),
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
