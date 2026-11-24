# @zukhruf/sqlite-queue

A program sends jobs to a queue, and workers do the jobs later, also after the program restarts. [pg-boss](https://github.com/timgit/pg-boss) is a job queue that keeps its jobs in Postgres. A program that has no Postgres server, for example a desktop app or a CLI, cannot use it. This package keeps the jobs in one SQLite file through `node:sqlite`, and gives the API of pg-boss: the same method names, the same options, the same results and the same errors. The API is a declared subset of pg-boss: 18 methods of `PgBoss`.

Zero divergence is the contract. A parity suite runs each scenario on real pg-boss 12.39.0 over PGlite, and on this package. Then it compares what each engine returned, stored and emitted. A test passes only when the two are equal. Thus a program can change from one engine to the other and keep its code.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment. It uses `node:sqlite`, pg-boss for its types and some of its values, and [`@zukhruf/sqlite-notify`](../notify/README.md) for the notify queues.

```sh
npm install @zukhruf/sqlite-queue
```

```ts
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type JobQueue, SqliteJobQueue } from '@zukhruf/sqlite-queue';

await using scratch = await mkdtempDisposable(join(tmpdir(), 'queue-'));
const queue: JobQueue = new SqliteJobQueue({
  path: join(scratch.path, 'jobs.sqlite'),
});
queue.on('error', (error) => console.error(error));
await queue.start();
await queue.createQueue('email', { retryLimit: 2 });
await queue.send('email', { to: 'ada@example.com' });

const sent = Promise.withResolvers<void>();
await queue.work('email', async ([job]) => {
  console.log('send to', job?.data);
  sent.resolve();
});
await sent.promise;
await queue.stop();
```

Output:

```
send to { to: 'ada@example.com' }
```

A `PgBoss` is also a `JobQueue`. Thus the same code runs on Postgres:

```ts
import { PgBoss } from 'pg-boss';

const queue: JobQueue = new PgBoss(process.env.DATABASE_URL);
```

## The rules

- `new SqliteJobQueue({ path })` owns the database file. `start()` opens it and makes the tables, and `stop()` closes it. Its write-ahead log syncs each commit to the disk, so a job that `send` acknowledged survives a power loss.
- `new SqliteJobQueue({ database })` uses a `DatabaseSync` that the caller opened. The caller closes it. The queue does not set the busy timeout of that connection. Open it with `open(path, { journal: new WriteAheadLog({ synchronous: 'full' }) })` of `@zukhruf/sqlite-open`. It sets a busy timeout of 5000 ms, and syncs each commit to the disk, as Postgres does for pg-boss ([ADR 0005](./docs/adr/0005-the-queue-keeps-the-durability-of-pg-boss.md)).
- With no `path` and no `database`, the queue keeps its jobs in memory.
- The other options are the options of pg-boss with the same names: `clock`, `supervise`, `superviseIntervalSeconds`, `monitorIntervalSeconds`, `maintenanceIntervalSeconds`, `queueCacheIntervalSeconds`, `warningQueueSize`, `useListenNotify`, `schedule`, `cronMonitorIntervalSeconds`, `cronWorkerIntervalSeconds` and `clockMonitorIntervalSeconds`. The defaults are the defaults of pg-boss.
- The types of the options, the jobs and the results come from pg-boss. Import them from `pg-boss`, for example `import type { Job, SendOptions } from 'pg-boss'`.
- Job data is `unknown`. `work()` gives each handler `Job<unknown>`, and `findJobs()` gives `FoundJob<unknown>`. Validate the data that you read.
- A listener for `error` is necessary. A failure in work that no caller awaits, for example a worker poll, goes to the `error` event. With no listener, `EventEmitter` throws.

## Notify queues

A queue with `notify: true` wakes its workers when a job comes, so they do not wait for their poll. pg-boss does this with `LISTEN` and `NOTIFY`. On a queue file, this package does it with [`@zukhruf/sqlite-notify`](../notify/README.md) ([ADR 0007](./docs/adr/0007-a-notify-queue-notifies-each-listener-on-the-file-through-sqlite-notify.md)).

- A send to a notify queue notifies when the stored job is due now. The notification is in the transaction of the insert. The sender notifies also when it does not listen, as in pg-boss.
- The channel is the channel of pg-boss, `pgboss_454650302e472074f72063fd`, and the payload is the queue name.
- With `useListenNotify`, `start()` listens on the channel. Each `SqliteJobQueue` that listens on the same file wakes the workers of the queue that the payload names, also in another program. The instance that sent the job also hears it.
- The poll of pg-boss stays. A worker of a notify queue fetches at least every `notifyPollingIntervalSeconds`, 30 by default.
- When the listen fails, the queue emits the warning of pg-boss, `listen_notify_unavailable`, and the workers poll.
- On a queue file, `start()` makes the tables of `sqlite-notify`, which start with `zukhruf_notify_`, if they are missing. `stop()` stops the listen.
- A database in memory has no file that another program can open. A send there wakes only the workers of the same `SqliteJobQueue`, when it listens.
- A send before `start()`, on a `database` of the caller, does not notify. pg-boss notifies there. The other instances find the job at their poll.

## Upgrades

A new release can change the tables. A file that an earlier release made keeps its jobs and its schedules ([ADR 0004](./docs/adr/0004-the-schema-is-a-declaration-and-keeps-the-jobs.md)).

- The schema is a declaration of [`@zukhruf/sqlite-drift`](../drift) with `rows: 'keep'`. `start()` compares the tables and the indexes in the file with the declaration.
- `start()` makes each missing object. It rebuilds each stale table and keeps its rows, and it replaces each stale index.
- No release writes a migration. The file records the version of the release that last applied the schema, and the version comes from the package itself: no person keeps a number ([ADR 0006](./docs/adr/0006-the-file-records-the-release-that-made-its-schema-and-an-older-release-leaves-it-alone.md)).
- A release that starts on a file of a later release changes nothing and goes on, as pg-boss does on a newer schema.
- When a kept row does not fit the declared table, `start()` fails with the error of SQLite, and the file stays as it was.
- When `pgboss_queue` is stale, the rebuild turns foreign keys off around its own transaction. Do not call `start()` in a transaction of your own.

## Schedules

A schedule sends a job to its queue at each time that its cron or rrule rule gives. The timekeeper of pg-boss does this work, and this package copies it ([ADR 0003](./docs/adr/0003-the-timekeeper-is-ported-literally.md)).

- `schedule` is `true` by default, as in pg-boss. `start()` then makes the queue `__pgboss__send-it`, starts one worker on it, and starts the cron pass. `schedule: false` starts none of them.
- The cron pass runs at start, then every `cronMonitorIntervalSeconds` (30 by default) on the clock. It finds the occurrences of each schedule in the last 60 seconds. For each occurrence of a schedule of the default precision, `'minute'`, it puts one job in `__pgboss__send-it`, in the slot of the minute of the occurrence. A unique index keeps one job for each schedule and slot, so the next pass does not send the same occurrence again.
- The worker of `__pgboss__send-it` polls every `cronWorkerIntervalSeconds` (5 by default). It sends each job to the queue of its schedule, with the data and the options of the schedule. Thus a job goes out up to 35 seconds after its time, as in pg-boss.
- With `precision: 'second'`, a cron expression with a seconds field sends one job for each occurrence, not one for each minute. The instance whose pass claims the cron stamp reads these schedules for one `cronMonitorIntervalSeconds` and checks them every second. It sends each job straight to the queue of the schedule, not through `__pgboss__send-it`. After a time when no pass ran, `skip` sends nothing and `once` sends the latest occurrence of that time. `schedule()` refuses `singletonNextSlot` with this precision.
- A cron expression without `tz` uses UTC. An rrule without `DTSTART` counts from 1970-01-01, so `FREQ=MINUTELY;INTERVAL=2` gives the even minutes.
- `missed` tells the pass what to do after a time when no pass ran, for example when the program was stopped. With `skip` (the default), the pass sends only the occurrences of the last 60 seconds. With `once`, the pass also sends the latest occurrence of that time, but not one from before the schedule was written.
- When the send to the queue of the schedule fails, the failure goes to the `error` event, and the job in `__pgboss__send-it` completes. The pass does not send the occurrence again.
- `__pgboss__send-it` is a queue like the others: `findJobs` reads its jobs. Its worker is not in the `wip` events.
- `clockMonitorIntervalSeconds` is validated only. pg-boss uses it to measure the difference between its clock and the clock of Postgres. Here the clock of the queue is the clock of the database.

## The subset

| Method                                                                          | What it does                                                                                                                                                       |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `on('error', listener)`                                                         | Receives the failures that no caller awaits.                                                                                                                       |
| `start()`, `stop(options)`                                                      | Start and stop the queue. A second call while one runs shares it.                                                                                                  |
| `createQueue(name, options)`, `updateQueue(name, options)`, `deleteQueue(name)` | Make, change and remove a queue, with its policy, retries, expiry, retention and dead letter queue.                                                                |
| `send(name, data, options)`, `send({ name, data, options })`                    | Add a job. It gives the id of the job, or `null` when a singleton or throttle refuses the job.                                                                     |
| `work(name, handler)`, `work(name, options, handler)`                           | Start workers that fetch jobs and give them to the handler. It gives the id of the work.                                                                           |
| `offWork(name, options)`                                                        | Stop the workers of a queue.                                                                                                                                       |
| `fetch(name, options)`                                                          | Claim up to `batchSize` jobs with no worker. It gives the jobs, which are then active.                                                                             |
| `findJobs(name, options)`                                                       | Find jobs by id, key, data or queued state.                                                                                                                        |
| `complete(name, id, data, options)`                                             | Complete jobs by id or by attempt. With `includeQueued`, also jobs that are not yet active.                                                                        |
| `touch(name, id)`                                                               | Keep the heartbeat of active jobs by id or by attempt.                                                                                                             |
| `getQueueStats(name, options)`                                                  | Give the counts of a queue by state, from the cache that the monitor keeps. A read counts again when the cache is older than one hour, or one minute with `force`. |
| `cancel(name, id)`, `fail(name, id, data)`                                      | Cancel or fail jobs by id or by attempt.                                                                                                                           |
| `schedule(name, cron, data, options)`, `unschedule(name, key)`                  | Send a job on a cron or rrule schedule, and remove the schedule.                                                                                                   |

Other methods of `PgBoss` are not in the subset, for example `getQueue`, `getJobById`, `retry`, `resume`, `deleteJob`, `sendAfter`, `insert` and `getDb`. A method or an option that needs Postgres itself, for example `getDb` and its SQL, or the `db` option of `fetch`, `complete`, `touch`, `cancel`, `fail`, `schedule` and `unschedule`, will not come.

## Errors

| Error                                      | When                                                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DatabaseError`                            | The same refusal that Postgres gives pg-boss, with its message and its SQLSTATE in `code`. For example `23503` for a dead letter queue that does not exist, `22P05` for `\u0000` in a JSON value, `23505`. |
| `UnsupportedStartAfterError`               | A `startAfter` string outside the forms that this package resolves: a `Date`, seconds, an ISO 8601 date time or duration, or Postgres interval units with integer amounts.                                 |
| The `Error` or `AssertionError` of pg-boss | A refused argument, with the message that pg-boss gives. For example `Workers are disabled. pg-boss is stopped`.                                                                                           |
| The error of SQLite                        | All other failures.                                                                                                                                                                                        |

Code that runs on both engines examines `code`, not the class. On Postgres, the error comes from the driver, not from this package, and `instanceof DatabaseError` is false. The `code` is the same on both engines.

A failure that no caller waits for is a process warning, in the shape of [root ADR 0010](../../../docs/adr/0010-a-package-warning-names-its-type-code-and-subject-and-keeps-the-failure-as-its-cause.md). A `'warning'` listener reads its type as `name`, its `code`, and its subject in `detail`, one `<term>: <value>` line each. Its `cause` is the failure, and its message ends with the failure's message. `--disable-warning=<code or type>` stops the print.

| Warning                 | Code                                        | Detail                                                                               | When                                                                                                                                        |
| ----------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `SqliteJobQueueWarning` | `ZUKHRUF_SQLITE_QUEUE_STOP_FAIL_UNHEARD`    | `queue: <name>` and `worker: <id>`                                                   | At a stop, the fail of a worker's active jobs fails, and nothing listens for `'error'`. The `cause` is the failure of the fail.             |
| `SqliteJobQueueWarning` | `ZUKHRUF_SQLITE_QUEUE_ERROR_LISTENER_THREW` | `queue: <name>` and `worker: <id>`                                                   | The same, and an `'error'` listener throws. The `cause` is what the listener threw.                                                         |
| `TimekeeperWarning`     | `ZUKHRUF_SQLITE_QUEUE_SEND_IT_UNREPORTED`   | `schedule: <name>` and `key: <key>`, or `job: <id>` when the job's data is no object | A send-it job fails to forward an occurrence, and its `'error'` reaches no listener, or a listener throws. The send-it job still completes. |
| `DeprecationWarning`    | `PGBOSS_DEP_FETCH_SORT`                     | none                                                                                 | A fetch gets `priority: false` or `orderByCreatedOn: false`. pg-boss's own code, once per option and instance.                              |

## The same concepts in other systems

| System                                              | What it does                                                                                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [pg-boss](https://github.com/timgit/pg-boss)        | The job queue that this package copies. It keeps the jobs in Postgres, and uses `SKIP LOCKED` to give each job to one worker.                                              |
| [Oban](https://hexdocs.pm/oban) and its Lite engine | A job queue for Elixir. Its engine is a part apart from its API: the Basic engine uses Postgres, and the Lite engine uses SQLite. The API does not change with the engine. |
| [Solid Queue](https://github.com/rails/solid_queue) | The job queue of Rails 8. It keeps the jobs in the database of the app: Postgres, MySQL or SQLite.                                                                         |

## API

The types that come from `pg-boss` (`Queue`, `SendOptions`, `Job`, `PgBossEventMap` and the others) are the types of pg-boss 12.39.0, as `src/job-queue.ts` and `src/index.ts` import them. pg-boss leaves `StartOptions` out of its exported types, so this package exports it, read off `PgBoss.start`.

```ts
// The subset of PgBoss, in the types of pg-boss. A PgBoss satisfies it as is.
interface JobQueue {
  on(event: 'error', listener: (error: Error) => void): this;
  start(options?: StartOptions): Promise<this>;
  stop(options?: StopOptions): Promise<void>;
  offWork(name: string, options?: OffWorkOptions): Promise<void>;
  createQueue(name: string, options?: Omit<Queue, 'name'>): Promise<void>;
  updateQueue(name: string, options?: UpdateQueueOptions): Promise<void>;
  deleteQueue(name: string): Promise<void>;
  // Only `force` is read: the history options need persistQueueStats.
  getQueueStats(
    name: string,
    options?: QueueStatsOptions,
  ): Promise<QueueStats[]>;
  send(request: Request): Promise<string | null>;
  send(
    name: string,
    data?: object | null,
    options?: SendOptions,
  ): Promise<string | null>; // null: a singleton or a throttle refused the job
  work(name: string, handler: WorkHandler<unknown>): Promise<string>;
  work(
    name: string,
    options: WorkOptions,
    handler: WorkHandler<unknown>,
  ): Promise<string>;
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
  complete(
    name: string,
    id: string | string[] | JobAttempt | JobAttempt[],
    data?: object | null,
    options?: CompleteOptions,
  ): Promise<CommandResponse>;
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

// JobWithMetadata of pg-boss, with the fields that findJobs gives as null.
type FoundJob<T> = Omit<
  JobWithMetadata<T>,
  'startedOn' | 'deadLetter' | 'retryDelayMax' | 'output' | 'policy' | 'signal'
> & {
  policy: QueuePolicy | null; // null for a dead letter copy
  startedOn: Date | null;
  deadLetter: string | null;
  retryDelayMax?: number | null;
  output: object | null;
};

interface SqliteJobQueueOptions
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
  path?: string; // the queue file; default: ':memory:'
  database?: DatabaseSync; // a connection that the caller opened and closes
  clock?: Clock; // default: systemClock of pg-boss
  useListenNotify?: boolean; // default: false
}

// The events are error, warning, wip and stopped, with the payloads of pg-boss.
class SqliteJobQueue
  extends EventEmitter<
    Pick<PgBossEventMap, 'error' | 'warning' | 'wip' | 'stopped'>
  >
  implements JobQueue
{
  // A string is the path of the queue file: new SqliteJobQueue(path) is
  // new SqliteJobQueue({ path }). No argument keeps the jobs in memory.
  constructor(options?: string | SqliteJobQueueOptions);
  send<TData extends object>(
    name: string,
    data?: TData | null,
    options?: SendOptions,
  ): Promise<string | null>;
  schedule<TData extends object>(
    name: string,
    cron: string,
    data?: TData | null,
    options?: ScheduleOptions,
  ): Promise<void>;
  // The other methods of JobQueue, with the same signatures.
}

// The refusal that Postgres gives pg-boss: `code` is the SQLSTATE.
class DatabaseError extends Error {
  name: string; // 'error', the name that node-postgres and PGlite give
  readonly code: string;
  constructor(message: string, code: string);
}

// A startAfter string outside the forms that this package resolves.
class UnsupportedStartAfterError extends Error {
  name: string; // 'UnsupportedStartAfterError'
  readonly startAfter: string;
  constructor(startAfter: string);
}
```

`src/several-processes.test.ts` opens the queue file with the string form, `new SqliteJobQueue(path)`.

## Documentation

**Recipes**

- [Run a cron schedule on a queue file that survives a restart](./docs/recipes/run-a-schedule-on-a-queue-file.md)

**Decisions**

- [0001 pg-boss's API on SQLite](./docs/adr/0001-pg-boss-api-on-sqlite.md)
- [0002 The parity suite is the contract](./docs/adr/0002-the-parity-suite-is-the-contract.md)
- [0003 The timekeeper is ported literally](./docs/adr/0003-the-timekeeper-is-ported-literally.md)
- [0004 The schema is a declaration and keeps the jobs](./docs/adr/0004-the-schema-is-a-declaration-and-keeps-the-jobs.md)
- [0005 The queue keeps the durability of pg-boss](./docs/adr/0005-the-queue-keeps-the-durability-of-pg-boss.md)
- [0007 A notify queue notifies each listener on the file through sqlite-notify](./docs/adr/0007-a-notify-queue-notifies-each-listener-on-the-file-through-sqlite-notify.md)

## Development

This package is part of the [zukhruf](../../../README.md) workspace. Run the commands from the workspace root.

```sh
npm install
npx nx run sqlite-queue:test        # builds, then runs the unit tests and the parity suite
npx nx run sqlite-queue:typecheck   # formats, lints, then type checks
npx nx run sqlite-queue:build       # compiles src/ to dist/
```

The test target sets `TZ=Asia/Kolkata`. The parity suite needs a zone that is not UTC, because pg-boss reads a throttle slot as local time.

```
src/
  index.ts           SqliteJobQueue and the exports
  job-queue.ts       JobQueue, the subset, and FoundJob
  *.ts               the parts of the port, each one cites the pg-boss code that it copies
  *.test.ts          the unit tests, for behavior that only SQLite has
  parity/            the parity suite: each scenario on pg-boss over PGlite and on SQLite
```

Each pg-boss citation names lines of the pinned pg-boss, and lint holds it there ([ADR 0001](./docs/adr/0001-pg-boss-api-on-sqlite.md)). On a pg-boss bump, lint fails with `cited`. Install the new pin, then run `npx nx run sqlite-queue:repoint-citations` before you edit a citation by hand, because it leaves the lines changed since HEAD alone. It moves each cited line to its line in the new version. It lists each cited line in a block that the new version changed, and then exits 1. Cite those lines by hand, run `npx nx run sqlite-queue:repoint-citations --checked` to record the new version in `pg-boss-citations.json`, and commit. In Markdown, the codemod also reads a `(N)` in prose after a citation as a line of that citation; the flagged list and a review of the diff catch such a move.
