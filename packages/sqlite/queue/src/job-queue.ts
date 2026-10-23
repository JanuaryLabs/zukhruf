import type {
  CommandResponse,
  FindJobsOptions,
  JobAttempt,
  JobWithMetadata,
  OffWorkOptions,
  Queue,
  QueuePolicy,
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
// (node_modules/pg-boss/dist/plans.js:561, 570, 573, 574) and findJobs returns
// them as stored (plans.js:599, 601, 609, 613), so a job that has not started
// has `startedOn: null` in pg-boss too. `retryDelayMax` stays optional so a
// PgBoss still satisfies the type.
export type FoundJob<T> = Omit<
  JobWithMetadata<T>,
  'startedOn' | 'deadLetter' | 'retryDelayMax' | 'output' | 'policy'
> & {
  // A dead letter copy is inserted without a policy (plans.js:2615-2643).
  policy: QueuePolicy | null;
  startedOn: Date | null;
  deadLetter: string | null;
  retryDelayMax?: number | null;
  output: object | null;
};

// The subset of pg-boss's PgBoss API (node_modules/pg-boss/dist/index.d.ts)
// that SqliteJobQueue implements, in pg-boss's own types. A PgBoss instance
// satisfies it as is. Job data is unknown: a caller validates what it reads.
export interface JobQueue {
  // Failures in work no caller awaits — worker polls, cron, the pool. With no
  // listener, EventEmitter throws on emit.
  on(event: 'error', listener: (error: Error) => void): this;
  start(): Promise<this>;
  stop(options?: StopOptions): Promise<void>;
  offWork(name: string, options?: OffWorkOptions): Promise<void>;
  createQueue(name: string, options?: Omit<Queue, 'name'>): Promise<void>;
  updateQueue(name: string, options?: UpdateQueueOptions): Promise<void>;
  deleteQueue(name: string): Promise<void>;
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
  findJobs(
    name: string,
    options?: FindJobsOptions,
  ): Promise<FoundJob<unknown>[]>;
  cancel(
    name: string,
    id: string | string[] | JobAttempt | JobAttempt[],
  ): Promise<CommandResponse>;
  fail(
    name: string,
    id: string | string[] | JobAttempt | JobAttempt[],
    data?: object | null,
  ): Promise<CommandResponse>;
  schedule(
    name: string,
    cron: string,
    data?: object | null,
    options?: ScheduleOptions,
  ): Promise<void>;
  unschedule(name: string, key?: string): Promise<void>;
}
