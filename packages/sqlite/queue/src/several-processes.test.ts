import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, it } from 'node:test';

import { TestClock, type WorkOptions } from 'pg-boss';

import { settleWithin } from '@zukhruf/testing/async';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import { SqliteJobQueue } from './index.ts';
import { id } from './testing/job-id.ts';

// Another process that opens the queue file and works the queue 'jobs'. It
// writes the id of each job that its handler gets, one per line. A process of
// its own, because the claims of one process run one after the other: only a
// second process can read the jobs while the first one claims them.
//
// 'complete' ends the handler at once. 'hold' never ends it, so each job
// that the process got stays active until the process ends.
function startWorker(
  path: string,
  options: WorkOptions,
  handler: 'complete' | 'hold',
  onJob: (jobId: string) => void,
) {
  const source = `
    import { createInterface } from 'node:readline';
    import { SqliteJobQueue } from ${JSON.stringify(new URL('./index.ts', import.meta.url).href)};
    const queue = new SqliteJobQueue(${JSON.stringify(path)});
    queue.on('error', (error) => console.error(error));
    await queue.start();
    const never = new Promise(() => {});
    console.log('ready');
    for await (const line of createInterface({ input: process.stdin })) {
      await queue.work('jobs', ${JSON.stringify(options)}, async (jobs) => {
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
    ready: () => settleWithin(ready.promise, 'a worker process opens', 10_000),
    work() {
      child.stdin.write('work\n');
    },
    // No more input: the process stops its queue, or, when it holds its
    // jobs, only says that it read all its input.
    async idle() {
      child.stdin.end();
      await settleWithin(idle.promise, 'a worker process is idle', 10_000);
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
  it('run each job one time', async () => {
    await using dir = await new TemporaryFiles().directory('sqlite-queue-');
    const path = join(dir.path, 'queue.db');
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
    await using first = startWorker(path, options, 'complete', onJob);
    await using second = startWorker(path, options, 'complete', onJob);
    await using third = startWorker(path, options, 'complete', onJob);
    const workers = [first, second, third];
    await Promise.all(workers.map((worker) => worker.ready()));

    for (const worker of workers) worker.work();
    await settleWithin(allRan.promise, 'each job runs', 10_000);
    await Promise.all(workers.map((worker) => worker.idle()));

    assert.deepEqual(
      runs.filter((jobId, index) => runs.indexOf(jobId) !== index),
      [],
      'jobs that ran more than one time',
    );
    assert.deepEqual(runs.toSorted(), ids);
  });

  it('never run more jobs of a group than groupConcurrency', async () => {
    await using dir = await new TemporaryFiles().directory('sqlite-queue-');
    const path = join(dir.path, 'queue.db');
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
    await using first = startWorker(path, options(1), 'hold', onJob);
    await using second = startWorker(path, options(2), 'hold', onJob);
    await using third = startWorker(path, options(3), 'hold', onJob);
    const workers = [first, second, third];
    await Promise.all(workers.map((worker) => worker.ready()));

    for (const worker of workers) worker.work();
    await settleWithin(allFull.promise, 'each group is full', 10_000);
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
      await using owner = startWorker(path, {}, 'hold', () =>
        claimed.resolve(),
      );
      await owner.ready();
      owner.work();
      await settleWithin(claimed.promise, 'the process runs the job', 10_000);
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

      await t.waitFor(
        () => assert.deepEqual(runs, [{ id: id(1), retryCount: 1 }]),
        { interval: 5, timeout: 10_000 },
      );
    } finally {
      await survivor.stop();
    }
  });
});
