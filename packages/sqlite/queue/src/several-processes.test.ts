import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, it } from 'node:test';

import { TestClock, type WorkOptions } from 'pg-boss';

import { untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';

import { SqliteJobQueue } from './index.ts';
import { id } from './testing/job-id.ts';

// Another process that opens the queue file and works one queue. It writes
// the id of each job that its handler gets, one per line. A process of
// its own, because the claims of one process run one after the other: only a
// second process can read the jobs while the first one claims them.
//
// 'complete' ends the handler at once. 'hold' never ends it, so each job
// that the process got stays active until the process ends.
function startWorker(
  queue: { path: string; name: string; useListenNotify: boolean },
  options: WorkOptions,
  handler: 'complete' | 'hold',
  onJob: (jobId: string) => void,
  signal: AbortSignal,
) {
  const source = `
    import { createInterface } from 'node:readline';
    import { SqliteJobQueue } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
    const queue = new SqliteJobQueue(${JSON.stringify({ path: queue.path, useListenNotify: queue.useListenNotify })});
    queue.on('error', (error) => console.error(error));
    await queue.start();
    const never = new Promise(() => {});
    console.log('ready');
    for await (const line of createInterface({ input: process.stdin })) {
      await queue.work(${JSON.stringify(queue.name)}, ${JSON.stringify(options)}, async (jobs) => {
        for (const job of jobs) console.log(job.id);
        ${handler === 'hold' ? 'await never;' : ''}
      });
    }
    ${handler === 'hold' ? '' : 'await queue.stop();'}
    console.log('idle');
  `;
  const child = spawn(
    process.execPath,
    ['--no-warnings', '--input-type=module', '--eval', source],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const exited = once(child, 'exit');
  const ready = Promise.withResolvers<void>();
  const idle = Promise.withResolvers<void>();
  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line === 'ready') ready.resolve();
    else if (line === 'idle') idle.resolve();
    else onJob(line);
  });
  return {
    ready: () => untilAborted(ready.promise, signal),
    work() {
      child.stdin.write('work\n');
    },
    // No more input: the process stops its queue, or, when it holds its
    // jobs, only says that it read all its input.
    async idle() {
      child.stdin.end();
      await untilAborted(idle.promise, signal);
    },
    // The exit code, once the process ends by itself.
    async exit() {
      const [code] = await untilAborted(exited, signal);
      return code;
    },
    async [Symbol.asyncDispose]() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGKILL');
      await exited;
    },
  };
}

// SQLite-only: on Postgres, FOR UPDATE SKIP LOCKED gives each job to one
// claim (node_modules/pg-boss/dist/plans.js:1885). pg-boss needs a server for
// a second process, so the parity suite has one process on each side.
describe('several processes on one queue file', () => {
  it('run each job one time', async (t) => {
    await using dir = await new TemporaryFiles().directory('sqlite-queue-');
    const path = join(dir.path, 'queue.db');
    const workerQueue = { path, name: 'jobs', useListenNotify: false };
    const ids = Array.from({ length: 200 }, (_, index) => id(index + 1));
    const queue = new SqliteJobQueue(path);
    await queue.start();
    try {
      await queue.createQueue('jobs');
      for (const jobId of ids) {
        await queue.send('jobs', null, { id: jobId });
      }
    } finally {
      await queue.stop();
    }
    const runs: string[] = [];
    const allRan = Promise.withResolvers<void>();
    const onJob = (jobId: string) => {
      runs.push(jobId);
      if (new Set(runs).size === ids.length) allRan.resolve();
    };
    const options = { batchSize: 5, burstWhenBatchFull: true };
    await using first = startWorker(
      workerQueue,
      options,
      'complete',
      onJob,
      t.signal,
    );
    await using second = startWorker(
      workerQueue,
      options,
      'complete',
      onJob,
      t.signal,
    );
    await using third = startWorker(
      workerQueue,
      options,
      'complete',
      onJob,
      t.signal,
    );
    const workers = [first, second, third];
    await Promise.all(workers.map((worker) => worker.ready()));

    for (const worker of workers) worker.work();
    await untilAborted(allRan.promise, t.signal);
    await Promise.all(workers.map((worker) => worker.idle()));

    assert.deepEqual(
      runs.filter((jobId, index) => runs.indexOf(jobId) !== index),
      [],
      'jobs that ran more than one time',
    );
    assert.deepEqual(runs.toSorted(), ids);
  });

  it('never run more jobs of a group than groupConcurrency', async (t) => {
    await using dir = await new TemporaryFiles().directory('sqlite-queue-');
    const path = join(dir.path, 'queue.db');
    const workerQueue = { path, name: 'jobs', useListenNotify: false };
    // Each process takes the jobs of one priority only, so no two processes
    // want the same job: they only share the limit of each group. Each
    // group has two jobs of each priority, so one process can fill a group.
    const priorities = [1, 2, 3];
    const groups = Array.from({ length: 20 }, (_, index) => `group-${index}`);
    const groupOf = new Map<string, string>();
    const queue = new SqliteJobQueue(path);
    await queue.start();
    try {
      await queue.createQueue('jobs');
      for (const priority of priorities) {
        for (const group of groups) {
          for (const _ of [1, 2]) {
            const jobId = id(groupOf.size + 1);
            groupOf.set(jobId, group);
            await queue.send('jobs', null, {
              id: jobId,
              priority,
              group: { id: group },
            });
          }
        }
      }
    } finally {
      await queue.stop();
    }
    // The jobs that run now, by group: no handler ends.
    const running = new Map(
      groups.map((group): [string, string[]] => [group, []]),
    );
    const allFull = Promise.withResolvers<void>();
    const onJob = (jobId: string) => {
      running.get(groupOf.get(jobId) ?? '')?.push(jobId);
      if (running.values().every((jobs) => jobs.length >= 2)) {
        allFull.resolve();
      }
    };
    const options = (priority: number) => ({
      batchSize: 2 * groups.length,
      groupConcurrency: 2,
      minPriority: priority,
      maxPriority: priority,
    });
    await using first = startWorker(
      workerQueue,
      options(1),
      'hold',
      onJob,
      t.signal,
    );
    await using second = startWorker(
      workerQueue,
      options(2),
      'hold',
      onJob,
      t.signal,
    );
    await using third = startWorker(
      workerQueue,
      options(3),
      'hold',
      onJob,
      t.signal,
    );
    const workers = [first, second, third];
    await Promise.all(workers.map((worker) => worker.ready()));

    for (const worker of workers) worker.work();
    await untilAborted(allFull.promise, t.signal);
    await Promise.all(workers.map((worker) => worker.idle()));

    assert.deepEqual(
      Object.fromEntries([...running].filter(([, jobs]) => jobs.length > 2)),
      {},
      'groups that run more than 2 jobs',
    );
  });

  it('run again the job of a process that ended in the handler, when the heartbeat of the job is late', async (t) => {
    await using dir = await new TemporaryFiles().directory('sqlite-queue-');
    const path = join(dir.path, 'queue.db');
    const workerQueue = { path, name: 'jobs', useListenNotify: false };
    const queue = new SqliteJobQueue(path);
    await queue.start();
    try {
      await queue.createQueue('jobs', { heartbeatSeconds: 10 });
      await queue.send('jobs', null, { id: id(1) });
    } finally {
      await queue.stop();
    }
    const claimed = Promise.withResolvers<void>();
    {
      await using owner = startWorker(
        workerQueue,
        {},
        'hold',
        () => claimed.resolve(),
        t.signal,
      );
      await owner.ready();
      owner.work();
      await untilAborted(claimed.promise, t.signal);
    }
    // The process that stays has a clock of its own, which starts at the
    // real time and which the test moves, so the test does not wait 10 real
    // seconds for a late heartbeat.
    const clock = new TestClock();
    const survivor = new SqliteJobQueue({
      path,
      clock,
      supervise: true,
      superviseIntervalSeconds: 1,
    });
    await survivor.start();
    try {
      const runs: { id: string; retryCount: number }[] = [];
      await survivor.work('jobs', { includeMetadata: true }, async (jobs) => {
        for (const job of jobs) {
          runs.push({ id: job.id, retryCount: job.retryCount });
        }
      });

      // A supervise pass examines the heartbeats of a queue one time in each
      // monitor interval, 60 seconds, and the process that ended had the
      // last one.
      await clock.tick(120_000);

      await waitFor(
        () => assert.deepEqual(runs, [{ id: id(1), retryCount: 1 }]),
        { signal: t.signal, interval: 5 },
      );
    } finally {
      await survivor.stop();
    }
  });

  // node_modules/pg-boss/dist/plans.js:2335-2350: the insert of a job that is
  // due now sends a pg_notify on a notify queue, whether or not the sender
  // listens (manager.js:1132-1134). Each listener on the schema then wakes
  // the workers of the queue that the payload names (notifier.js:57,
  // manager.js:1137-1143), before their poll. The poll here is an hour, also
  // when the queue does not listen (attorney.js:587, 601): longer than the
  // test runner lets a test run (--test-timeout), so only the notification
  // can run the second job of each queue before the test ends.
  it('wake the workers of each process that listens, when another process sends to a notify queue', async (t) => {
    await using dir = await new TemporaryFiles().directory('sqlite-queue-');
    const path = join(dir.path, 'queue.db');
    const sender = new SqliteJobQueue(path);
    await sender.start();
    try {
      await sender.createQueue('first', { notify: true });
      await sender.createQueue('second', { notify: true });
      // The first job of each queue ends the first fetch, so each worker then
      // waits for its poll.
      await sender.send('first', null, { id: id(1) });
      await sender.send('second', null, { id: id(2) });
      // The id of each job that a process ran, and the waits for them.
      const ran = new Map(
        [1, 2, 3, 4].map((index) => [id(index), Promise.withResolvers<void>()]),
      );
      const onJob = (jobId: string) => ran.get(jobId)?.resolve();
      const runOf = (index: number) => {
        const run = ran.get(id(index));
        assert.ok(run);
        return run.promise;
      };
      await using first = startWorker(
        { path, name: 'first', useListenNotify: true },
        { pollingIntervalSeconds: 3600 },
        'complete',
        onJob,
        t.signal,
      );
      await using second = startWorker(
        { path, name: 'second', useListenNotify: true },
        { pollingIntervalSeconds: 3600 },
        'complete',
        onJob,
        t.signal,
      );
      await Promise.all([first.ready(), second.ready()]);
      first.work();
      second.work();
      await untilAborted(Promise.all([runOf(1), runOf(2)]), t.signal);

      await sender.send('first', null, { id: id(3) });
      await sender.send('second', null, { id: id(4) });

      await untilAborted(Promise.all([runOf(3), runOf(4)]), t.signal);
    } finally {
      await sender.stop();
    }
  });

  // pg-boss's stop() closes its listener (index.js:228, notifier.js:70-77):
  // the program that stopped its queue ends by itself.
  it('let a process that listened end by itself after it stops its queue', async (t) => {
    await using dir = await new TemporaryFiles().directory('sqlite-queue-');
    const path = join(dir.path, 'queue.db');
    await using worker = startWorker(
      { path, name: 'jobs', useListenNotify: true },
      {},
      'complete',
      () => {},
      t.signal,
    );
    await worker.ready();

    await worker.idle();

    assert.equal(await worker.exit(), 0);
  });
});
