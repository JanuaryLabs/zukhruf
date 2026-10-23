# @zukhruf/sqlite-queue

A program sends jobs to a queue, and workers do the jobs later, also after the program restarts. [pg-boss](https://github.com/timgit/pg-boss) is a job queue that keeps its jobs in Postgres. A program that has no Postgres server, for example a desktop app or a CLI, cannot use it. This package keeps the jobs in one SQLite file through `node:sqlite`, and gives the API of pg-boss: the same method names, the same options, the same results and the same errors. The API is a declared subset of pg-boss: 13 methods of `PgBoss`.

Zero divergence is the contract. A parity suite runs each scenario on real pg-boss 12.35.1 over PGlite, and on this package. Then it compares what each engine returned, stored and emitted. A test passes only when the two are equal. Thus a program can change from one engine to the other and keep its code.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment. It uses `node:sqlite`, and it uses pg-boss for its types and some of its values.

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

- `new SqliteJobQueue({ path })` owns the database file. `start()` opens it and makes the tables, and `stop()` closes it.
- `new SqliteJobQueue({ database })` uses a `DatabaseSync` that the caller opened. The caller closes it.
- With no `path` and no `database`, the queue keeps its jobs in memory.
- The other options are the options of pg-boss with the same names: `clock`, `supervise`, `superviseIntervalSeconds`, `monitorIntervalSeconds`, `maintenanceIntervalSeconds`, `queueCacheIntervalSeconds`, `warningQueueSize` and `useListenNotify`. The defaults are the defaults of pg-boss.
- The types of the options, the jobs and the results come from pg-boss. Import them from `pg-boss`, for example `import type { Job, SendOptions } from 'pg-boss'`.
- Job data is `unknown`. `work()` gives each handler `Job<unknown>`, and `findJobs()` gives `FoundJob<unknown>`. Validate the data that you read.
- A listener for `error` is necessary. A failure in work that no caller awaits, for example a worker poll, goes to the `error` event. With no listener, `EventEmitter` throws.
- `useListenNotify` wakes the workers of this `SqliteJobQueue` only. In pg-boss, each listener on the schema hears a `NOTIFY`. Here, another instance on the same file does not hear it.
- A schedule fires from a poll on real time, every `schedulePollingIntervalMs` (1000 by default). `schedule: false` stops the poll. pg-boss uses its timekeeper on the clock for this. The port of the timekeeper is not done.

## The subset

| Method                                                                          | What it does                                                                                        |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `on('error', listener)`                                                         | Receives the failures that no caller awaits.                                                        |
| `start()`, `stop(options)`                                                      | Start and stop the queue. A second call while one runs shares it.                                   |
| `createQueue(name, options)`, `updateQueue(name, options)`, `deleteQueue(name)` | Make, change and remove a queue, with its policy, retries, expiry, retention and dead letter queue. |
| `send(name, data, options)`, `send({ name, data, options })`                    | Add a job. It gives the id of the job, or `null` when a singleton or throttle refuses the job.      |
| `work(name, handler)`, `work(name, options, handler)`                           | Start workers that fetch jobs and give them to the handler. It gives the id of the work.            |
| `offWork(name, options)`                                                        | Stop the workers of a queue.                                                                        |
| `findJobs(name, options)`                                                       | Find jobs by id, key, data or queued state.                                                         |
| `cancel(name, id)`, `fail(name, id, data)`                                      | Cancel or fail jobs by id or by attempt.                                                            |
| `schedule(name, cron, data, options)`, `unschedule(name, key)`                  | Send a job on a cron or rrule schedule, and remove the schedule.                                    |

Other methods of `PgBoss` are not in the subset, for example `getQueue`, `getJobById`, `complete`, `retry`, `resume`, `deleteJob`, `sendAfter`, `insert` and `getDb`. A method that needs Postgres itself, for example `getDb` and its SQL, will not come.

## Errors

| Error                                      | When                                                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DatabaseError`                            | The same refusal that Postgres gives pg-boss, with its message and its SQLSTATE in `code`. For example `23503` for a dead letter queue that does not exist, `22P05` for `\u0000` in a JSON value, `23505`. |
| `UnsupportedStartAfterError`               | A `startAfter` string outside the forms that this package resolves: a `Date`, seconds, an ISO 8601 date time or duration, or Postgres interval units with integer amounts.                                 |
| The `Error` or `AssertionError` of pg-boss | A refused argument, with the message that pg-boss gives. For example `Workers are disabled. pg-boss is stopped`.                                                                                           |
| The error of SQLite                        | All other failures.                                                                                                                                                                                        |

Code that runs on both engines examines `code`, not the class. On Postgres, the error comes from the driver, not from this package, and `instanceof DatabaseError` is false. The `code` is the same on both engines.

## The same concepts in other systems

| System                                              | What it does                                                                                                                                                               |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [pg-boss](https://github.com/timgit/pg-boss)        | The job queue that this package copies. It keeps the jobs in Postgres, and uses `SKIP LOCKED` to give each job to one worker.                                              |
| [Oban](https://hexdocs.pm/oban) and its Lite engine | A job queue for Elixir. Its engine is a part apart from its API: the Basic engine uses Postgres, and the Lite engine uses SQLite. The API does not change with the engine. |
| [Solid Queue](https://github.com/rails/solid_queue) | The job queue of Rails 8. It keeps the jobs in the database of the app: Postgres, MySQL or SQLite.                                                                         |

## Documentation

- [0001 pg-boss's API on SQLite](./docs/adr/0001-pg-boss-api-on-sqlite.md)
- [0002 The parity suite is the contract](./docs/adr/0002-the-parity-suite-is-the-contract.md)

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
