# Recipe: Run a cron schedule on a queue file that survives a restart

**Use case.** A desktop app or a service has no Postgres server, but it must do work on a cron schedule: a daily refresh of a connector, or a scheduled watch run. A timer in memory forgets the schedule when the program stops, and a refresh that a stop interrupts does not run again. A `SqliteJobQueue` with `path` keeps the queues, the jobs and the schedules in one queue file. After the next start, the schedule sends its jobs again, and an interrupted job runs again. Two consumers use the queue so: websets sends its scheduled watch runs on their crons (`apps/websets/src/queue.ts` in context-compiler), and text2sql sends its daily connector refresh through the send-it queue, with `schedule: true` (`apps/desktop/backend/src/core/background/chat-queue.ts`).

**What you need.** `SqliteJobQueue` with `path`, a queue, a schedule on it, and a worker. The program gives the `clock` option a `TestClock` of pg-boss so that a day passes in a moment. A real program gives no `clock`.

## The steps

1. Make the queue with `new SqliteJobQueue({ path })`. Add a listener for `error`.
2. Call `start()`, then `createQueue(name)`.
3. Call `schedule(name, cron, data)` one time. The queue file keeps the schedule, so a later start does not have to write it again.
4. Call `work(name, handler)` after each start.
5. Call `stop()` before the program exits.

## The program

The first program writes a daily schedule for 09:00 UTC, and a stop interrupts the first refresh. The second program opens the same queue file and does not write the schedule. It runs the interrupted refresh, and on the next day the schedule sends a new refresh.

```ts title="daily-refresh.ts"
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TestClock } from 'pg-boss';

import { SqliteJobQueue } from '@zukhruf/sqlite-queue';

await using scratch = await mkdtempDisposable(join(tmpdir(), 'queue-'));
const path = join(scratch.path, 'jobs.sqlite');

// A clock that the program moves by hand, so a day passes in a moment.
const clock = new TestClock('2026-01-01T08:59:30.000Z');
const at = () => new Date(clock.now()).toISOString().slice(0, 16);

// The program before the restart: it writes the schedule, and a stop
// interrupts the first refresh.
{
  const queue = new SqliteJobQueue({ path, clock });
  queue.on('error', (error) => console.error(error));
  await queue.start();
  await queue.createQueue('refresh');
  await queue.schedule('refresh', '0 9 * * *', { dataSourceId: 'sales' });
  await queue.work('refresh', async ([job]) => {
    console.log(`${at()} first program: refresh`, job?.data, 'starts');
    await new Promise(() => {}); // The refresh is still under way at the stop.
  });
  await clock.tick(40_000);
  await queue.stop({ graceful: false });
}

// The program after the restart: a new SqliteJobQueue on the same file. It
// does not write the schedule again.
{
  const queue = new SqliteJobQueue({ path, clock });
  queue.on('error', (error) => console.error(error));
  await queue.start();
  const [interrupted] = await queue.findJobs('refresh');
  console.log(
    `${at()} second program: the job's state is ${interrupted?.state}`,
  );
  await queue.work('refresh', async ([job]) => {
    console.log(`${at()} second program: refresh`, job?.data, 'completes');
  });
  await clock.tick(5_000);
  await clock.setTime('2026-01-02T08:59:50.000Z');
  await clock.tick(40_000);
  for (const job of await queue.findJobs('refresh')) {
    console.log(
      `job sent ${job.createdOn.toISOString().slice(0, 16)}: ${job.state}, retryCount ${job.retryCount}`,
    );
  }
  await queue.stop();
}
```

Output:

```
2026-01-01T09:00 first program: refresh { dataSourceId: 'sales' } starts
2026-01-01T09:00 second program: the job's state is retry
2026-01-01T09:00 second program: refresh { dataSourceId: 'sales' } completes
2026-01-02T09:00 second program: refresh { dataSourceId: 'sales' } completes
job sent 2026-01-01T09:00: completed, retryCount 1
job sent 2026-01-02T09:00: completed, retryCount 0
```

## What the output shows

- The cron pass found the occurrence of 09:00, and the worker of the send-it queue sent the job to `refresh`. The first program started the refresh.
- The stop failed the active job, so the queue file kept it in the state `retry`. The second program found it there.
- The second program ran the job again: `retryCount 1`.
- The second program did not call `schedule`. On the next day, the schedule that the queue file kept sent a new job, and it completed on its first attempt: `retryCount 0`.

## Things to know

- **A stop fails each active job, and the job then retries.** `stop()` fails the jobs that its workers hold with the output `pg-boss shut down while active`, as pg-boss does (`src/parity/batch.test.ts`). A job with retries left goes to `retry`, and the next start runs it again. A graceful stop first waits for the handlers, up to `timeout` milliseconds (30 000 by default).
- **A program that ends with no stop leaves the job active.** For example, a crash or a kill. The job then waits until it expires, and the supervisor fails it. Then it retries.
- **Write a handler that can run a second time.** A stop or a crash can interrupt a job after it did part of its work, and the next attempt starts from the beginning.
- **A program that is stopped at the time of an occurrence does not send it by default.** With `missed: 'skip'` (the default), the cron pass sends only the occurrences of the last 60 seconds. With `missed: 'once'`, it also sends the latest occurrence of the time when no pass ran. See [Schedules](../../README.md#schedules).
- **A job goes out up to 35 seconds after its time.** The cron pass runs every `cronMonitorIntervalSeconds` (30 by default), and the worker of the send-it queue polls every `cronWorkerIntervalSeconds` (5 by default). The timekeeper is the one of pg-boss ([ADR 0003](../adr/0003-the-timekeeper-is-ported-literally.md)).
- **A job that `send` acknowledged survives a power loss.** The queue file syncs each commit to the disk, as Postgres does for pg-boss ([ADR 0005](../adr/0005-the-queue-keeps-the-durability-of-pg-boss.md)).
- **`schedule: false` starts no cron pass and no send-it worker.** Then the schedules on the file send nothing. Keep the default `true` in the program that must send them.
