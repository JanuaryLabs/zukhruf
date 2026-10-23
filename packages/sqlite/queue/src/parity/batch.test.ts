import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TestClock } from 'pg-boss';

import { Parity } from './parity.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Lets everything due now finish on both backends: tick(0) waits until each
// one's statements in flight have settled, SQLite's through its attached
// Activity (node_modules/pg-boss/dist/clock.js:88-117, activity.js:77-93).
async function flush(clock: TestClock) {
  await clock.tick(0);
}

describe('batches', () => {
  it('fail a handler that outlives its expireInSeconds, and abort every job signal once the batch settles', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('slow');
      await queue.createQueue('quick');
      await queue.send('slow', null, {
        id: id(1),
        expireInSeconds: 1,
        retryLimit: 0,
      });
      await queue.send('quick', null, { id: id(2) });
      // Watched through abort listeners, as a handler watches its signal.
      const aborts: Record<string, number> = { slow: 0, quick: 0 };
      const watch = (name: string, signal: AbortSignal | undefined) =>
        signal?.addEventListener('abort', () => {
          aborts[name] = (aborts[name] ?? 0) + 1;
        });
      await queue.work('slow', {}, async ([job]) => {
        watch('slow', job?.signal);
        await new Promise<never>(() => undefined);
      });
      await queue.work('quick', {}, async ([job]) => {
        watch('quick', job?.signal);
      });
      await flush(clock);
      const beforeDeadline = structuredClone(aborts);
      await clock.tick(1000);
      await flush(clock);
      const [slow] = await queue.findJobs('slow', { id: id(1) });
      const [quick] = await queue.findJobs('quick', { id: id(2) });
      // Only the message until slice 4g stores pg-boss's whole serialized
      // error (name, message, stack).
      const output = slow?.output;
      return {
        beforeDeadline,
        afterDeadline: aborts,
        slow: {
          state: slow?.state,
          message: output && 'message' in output ? output.message : output,
        },
        quick: quick?.state,
      };
    });

    // The handler races a deadline of the batch's largest expireInSeconds,
    // on an abort controller every job's signal follows, which the race
    // aborts when it settles (node_modules/pg-boss/dist/manager.js:515-535,
    // 606; tools.js:66-77).
    assert.deepStrictEqual(observed, {
      beforeDeadline: { slow: 0, quick: 1 },
      afterDeadline: { slow: 1, quick: 1 },
      slow: { state: 'failed', message: 'handler execution exceeded 1s' },
      quick: 'completed',
    });
  });

  it('give a batch the deadline of its longest expireInSeconds', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', null, { id: id(1), expireInSeconds: 1 });
      await queue.send('jobs', null, { id: id(2), expireInSeconds: 900 });
      await queue.work('jobs', { batchSize: 2 }, async () => {
        await new Promise<never>(() => undefined);
      });
      await flush(clock);
      await clock.tick(1000);
      await flush(clock);
      return (await queue.findJobs('jobs')).map((job) => job.state);
    });

    // maxExpiration is the batch's largest (manager.js:515).
    assert.deepStrictEqual(observed, ['active', 'active']);
  });

  it('fail the jobs still running when stopping, then abort their handlers', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs', { retryLimit: 1 });
      for (const n of [1, 2, 3, 4]) {
        await queue.send('jobs', null, { id: id(n) });
      }
      let aborted = 0;
      // Two loops, each holding a two-job batch.
      await queue.work(
        'jobs',
        { batchSize: 2, localConcurrency: 2 },
        async (jobs) => {
          for (const job of jobs) {
            job.signal.addEventListener('abort', () => {
              aborted++;
            });
          }
          await new Promise<never>(() => undefined);
        },
      );
      await flush(clock);
      await queue.stop({ graceful: false, close: false });
      // A worker whose batch was abandoned finishes stopping; one still
      // stuck in its handler never would.
      const stopped = await Promise.race([
        queue.offWork('jobs').then(() => 'stopped'),
        new Promise((resolve) => setTimeout(() => resolve('stuck'), 5000)),
      ]);
      const jobs = await queue.findJobs('jobs');
      return {
        states: jobs.map((job) => job.state),
        outputs: jobs.map((job) => job.output),
        aborted,
        stopped,
        stopAgain: await queue.stop({ close: false }).then(() => 'resolved'),
        workAfter: await queue
          .work('jobs', {}, async () => {})
          .then(
            () => 'resolved',
            (error: Error) => error.message,
          ),
      };
    });

    // node_modules/pg-boss/dist/manager.js:884-909 fails each worker's jobs,
    // then aborts its batch; index.js:215-217 makes a second stop a no-op.
    const shutDown = { value: 'pg-boss shut down while active' };
    assert.deepStrictEqual(observed, {
      states: ['retry', 'retry', 'retry', 'retry'],
      outputs: [shutDown, shutDown, shutDown, shutDown],
      aborted: 4,
      stopped: 'stopped',
      stopAgain: 'resolved',
      workAfter: 'Workers are disabled. pg-boss is stopped',
    });
  });

  it('wait for handlers on a graceful stop only until its timeout, at least a second', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', null, { id: id(1) });
      await queue.work('jobs', {}, async () => {
        await new Promise<never>(() => undefined);
      });
      await flush(clock);
      const started = Date.now();
      // Below the floor: pg-boss waits at least a second (index.js:218).
      await queue.stop({ graceful: true, close: false, timeout: 10 });
      const waited = Date.now() - started;
      const [job] = await queue.findJobs('jobs', { id: id(1) });
      return {
        waitedAboutASecond: waited >= 900 && waited < 5000,
        state: job?.state,
      };
    });

    // The graceful wait runs on real time, never the configured clock, then
    // the stop fails what is still running (index.js:260-273).
    assert.deepStrictEqual(observed, {
      waitedAboutASecond: true,
      state: 'retry',
    });
  });

  it('stop gracefully by default, returning once handlers finish, and share one stop between callers', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', null, { id: id(1) });
      await queue.work('jobs', {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
      await flush(clock);
      const started = Date.now();
      const [first, second] = await Promise.all([
        queue.stop({ close: false }).then(() => 'resolved'),
        queue.stop({ close: false }).then(() => 'resolved'),
      ]);
      const waited = Date.now() - started;
      const [job] = await queue.findJobs('jobs', { id: id(1) });
      return {
        first,
        second,
        returnedEarly: waited < 5000,
        state: job?.state,
      };
    });

    // graceful defaults to true and its wait ends when the workers do, well
    // before the 30s timeout; a stop already under way is shared
    // (index.js:198-201, 260-273).
    assert.deepStrictEqual(observed, {
      first: 'resolved',
      second: 'resolved',
      returnedEarly: true,
      state: 'completed',
    });
  });

  it('ignore a stop before start, and still take work afterwards', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      const stopped = await queue.stop({ close: false }).then(() => 'resolved');
      const work = await queue
        .work('jobs', {}, async () => {})
        .then(
          () => 'resolved',
          (error: Error) => error.message,
        );
      // Started afterwards so the harness can stop it: PGlite never closes
      // under a pg-boss that took work() and never started.
      await queue.start();
      return { stopped, work };
    });

    // index.js:215-217: an instance that never started is already stopped.
    assert.deepStrictEqual(observed, { stopped: 'resolved', work: 'resolved' });
  });
});
