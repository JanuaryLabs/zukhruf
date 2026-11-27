import type {
  CommandResponse,
  CompleteOptions,
  FetchOptions,
  FindJobsOptions,
  Job,
  JobAttempt,
  JobWithMetadata,
  ListOptions,
  OffWorkOptions,
  PgBoss,
  Queue,
  QueuePolicy,
  QueueResult,
  QueueStats,
  QueueStatsOptions,
  Request,
  ScheduleOptions,
  SendOptions,
  StopOptions,
  UpdateQueueOptions,
  WorkHandler,
  WorkOptions,
} from 'pg-boss';

// pg-boss's JobWithMetadata with the fields its declaration marks non-null
// but its runtime returns as null: the schema stores them in nullable columns
// (node_modules/pg-boss/dist/plans.js:875, 884, 887, 888) and findJobs returns
// them as stored (plans.js:915, 917, 925, 929), so a job that has not started
// has `startedOn: null` in pg-boss too. `retryDelayMax` stays optional so a
// PgBoss still satisfies the type. Its declaration also inherits `signal` from
// Job, which findJobs never sets at run time (manager.js:2947-2976).
export type FoundJob<T> = Omit<
  JobWithMetadata<T>,
  'startedOn' | 'deadLetter' | 'retryDelayMax' | 'output' | 'policy' | 'signal'
> & {
  // A dead letter copy is inserted without a policy (plans.js:3384-3413).
  policy: QueuePolicy | null;
  startedOn: Date | null;
  deadLetter: string | null;
  retryDelayMax?: number | null;
  output: object | null;
};

// pg-boss's QueueResult with the fields that its runtime gives as null:
// getQueues reads nullable columns (node_modules/pg-boss/dist/plans.js:
// 346-386) as stored, so a queue with no dead letter has `deadLetter: null`,
// and singletons_active holds a null for an active job with no singletonKey.
// The optional fields stay optional so a PgBoss still satisfies the type.
export type ListedQueue = Omit<
  QueueResult,
  'deadLetter' | 'retryDelayMax' | 'heartbeatSeconds' | 'singletonsActive'
> & {
  deadLetter?: string | null;
  retryDelayMax?: number | null;
  heartbeatSeconds?: number | null;
  singletonsActive: (string | null)[] | null;
};

// The subset of pg-boss's PgBoss API (node_modules/pg-boss/dist/index.d.ts)
// that SqliteJobQueue implements, in pg-boss's own types. A PgBoss instance
// satisfies it as is. Job data is unknown: a caller validates what it reads.
// pg-boss 12.39.0 declares StartOptions (dist/types.d.ts:1455) but leaves it
// out of the root's exported types (dist/index.d.ts:128), so it is read off
// start() itself.
export type StartOptions = NonNullable<Parameters<PgBoss['start']>[0]>;

export interface JobQueue {
  // Failures in work no caller awaits — worker polls, cron, the pool. With no
  // listener, EventEmitter throws on emit.
  on(event: 'error', listener: (error: Error) => void): this;
  start(options?: StartOptions): Promise<this>;
  stop(options?: StopOptions): Promise<void>;
  offWork(name: string, options?: OffWorkOptions): Promise<void>;
  createQueue(name: string, options?: Omit<Queue, 'name'>): Promise<void>;
  updateQueue(name: string, options?: UpdateQueueOptions): Promise<void>;
  deleteQueue(name: string): Promise<void>;
  // One snapshot of the queue's counts, read from the cache that the monitor
  // keeps and counted again when it is too old. The history options need
  // persistQueueStats, which SqliteJobQueue does not have: only `force` is
  // read.
  getQueueStats(
    name: string,
    options?: QueueStatsOptions,
  ): Promise<QueueStats[]>;
  // Each queue's options and the counts that the monitor keeps, in name
  // order. The throughput fields need persistQueueStats, so they keep their
  // zeros and nulls.
  getQueues(names?: string[], options?: ListOptions): Promise<ListedQueue[]>;
  send(request: Request): Promise<string | null>;
  send(
    name: string,
    data?: object | null,
    options?: SendOptions,
  ): Promise<string | null>;
  work(name: string, handler: WorkHandler<unknown>): Promise<string>;
  work(
    name: string,
    options: WorkOptions,
    handler: WorkHandler<unknown>,
  ): Promise<string>;
  // A fetched job has no signal at run time, on both engines: only a worker
  // adds one (node_modules/pg-boss/dist/manager.js:613). The `db` option is a
  // Postgres connection, which SqliteJobQueue does not read.
  fetch(
    name: string,
    options: FetchOptions & { includeMetadata: true },
  ): Promise<JobWithMetadata<unknown>[]>;
  fetch(name: string, options?: FetchOptions): Promise<Job<unknown>[]>;
  findJobs(
    name: string,
    options?: FindJobsOptions,
  ): Promise<FoundJob<unknown>[]>;
  cancel(
    name: string,
    id: string | string[] | JobAttempt | JobAttempt[],
  ): Promise<CommandResponse>;
  // The `db` option is a Postgres connection, which SqliteJobQueue does not
  // read.
  complete(
    name: string,
    id: string | string[] | JobAttempt | JobAttempt[],
    data?: object | null,
    options?: CompleteOptions,
  ): Promise<CommandResponse>;
  // A caller of fetch() calls it to keep the heartbeat of its jobs, as work()
  // does for its own.
  touch(
    name: string,
    id: string | string[] | JobAttempt | JobAttempt[],
  ): Promise<CommandResponse>;
  fail(
    name: string,
    id: string | string[] | JobAttempt | JobAttempt[],
    data?: unknown,
  ): Promise<CommandResponse>;
  schedule(
    name: string,
    cron: string,
    data?: object | null,
    options?: ScheduleOptions,
  ): Promise<void>;
  unschedule(name: string, key?: string): Promise<void>;
}
