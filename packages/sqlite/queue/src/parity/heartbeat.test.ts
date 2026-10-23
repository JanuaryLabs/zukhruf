import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TestClock } from 'pg-boss';

import { ParityRun } from './backends.ts';
import { Parity } from './parity.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Lets everything due now finish on both backends: tick(0) waits until each
// one's statements in flight have settled, SQLite's through its attached
// Activity (node_modules/pg-boss/dist/clock.js:88-117, activity.js:77-93).
async function flush(clock: TestClock) {
  await clock.tick(0);
}

describe('heartbeats', () => {
  it('refresh a batch and abort only the jobs whose claim a heartbeat finds gone', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      const origin = Date.parse(ParityRun.start);
      const aborts: { id: string; at: number; reason: string }[] = [];
      const release = Promise.withResolvers<void>();
      const handler = async (jobs: { id: string; signal: AbortSignal }[]) => {
        for (const job of jobs) {
          job.signal.addEventListener('abort', () => {
            const reason: unknown = job.signal.reason;
            aborts.push({
              id: job.id,
              at: clock.now() - origin,
              reason: reason instanceof Error ? reason.message : String(reason),
            });
          });
        }
        await release.promise;
      };
      // The failed job's retry is not due when the batch ends, so no worker
      // claims it again before the states are read.
      await queue.createQueue('beats', {
        heartbeatSeconds: 10,
        retryDelay: 60,
      });
      await queue.createQueue('quiet');
      await queue.createQueue('mixed', { heartbeatSeconds: 30 });
      await queue.createQueue('override', { heartbeatSeconds: 10 });
      for (const n of [1, 2, 3]) {
        await queue.send('beats', null, { id: id(n) });
      }
      await queue.send('quiet', null, { id: id(4) });
      await queue.send('mixed', null, { id: id(5) });
      await queue.send('mixed', null, { id: id(6), heartbeatSeconds: 10 });
      await queue.send('override', null, { id: id(7) });
      await queue.work('beats', { batchSize: 3 }, handler);
      await queue.work('quiet', {}, handler);
      await queue.work('mixed', { batchSize: 2 }, handler);
      await queue.work('override', { heartbeatRefreshSeconds: 1 }, handler);
      const heartbeatOn = async (name: string, n: number) => {
        const [job] = await queue.findJobs(name, { id: id(n) });
        return job?.heartbeatOn ? job.heartbeatOn.getTime() - origin : null;
      };
      await flush(clock);
      await queue.cancel('beats', id(1));
      await queue.fail('beats', id(2));
      await queue.cancel('quiet', id(4));
      await flush(clock);
      const atOnce = [...aborts];
      await clock.tick(4999);
      await flush(clock);
      const beforeRefresh = [...aborts];
      const refreshedBy4999 = {
        mixed: await heartbeatOn('mixed', 5),
        override: await heartbeatOn('override', 7),
      };
      await clock.tick(1);
      await flush(clock);
      const afterRefresh = [...aborts];
      const refreshedBy5000 = {
        beats: await heartbeatOn('beats', 3),
        mixed: await heartbeatOn('mixed', 5),
      };
      release.resolve();
      await flush(clock);
      const states = Object.fromEntries(
        await Promise.all(
          [1, 2, 3, 4].map(async (n) => {
            const [job] = await queue.findJobs(n === 4 ? 'quiet' : 'beats', {
              id: id(n),
            });
            return [n, job?.state];
          }),
        ),
      );
      return {
        atOnce,
        beforeRefresh,
        refreshedBy4999,
        afterRefresh,
        refreshedBy5000,
        states,
      };
    });

    // Every heartbeatRefreshSeconds, or half the batch's shortest
    // heartbeatSeconds, the worker touches the attempts it still holds
    // (fenced); a job the touch no longer finds active loses its own claim
    // signal, and without heartbeatSeconds nothing aborts on cancel or fail
    // (node_modules/pg-boss/dist/manager.js:520-565; plans.js:2387-2400).
    const lost = (n: number) => ({
      id: id(n),
      at: 5000,
      reason: `job ${id(n)} is no longer active under this worker's claim`,
    });
    assert.deepStrictEqual(observed, {
      atOnce: [],
      beforeRefresh: [],
      refreshedBy4999: { mixed: 0, override: 4000 },
      afterRefresh: [lost(1), lost(2)],
      refreshedBy5000: { beats: 5000, mixed: 5000 },
      states: { 1: 'cancelled', 2: 'retry', 3: 'completed', 4: 'cancelled' },
    });
  });

  it('touch only the attempt a batch claimed, so a later claim of its job aborts the earlier one', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      const origin = Date.parse(ParityRun.start);
      const aborts: { attempt: number; at: number; reason: string }[] = [];
      const releases = new Map<number, PromiseWithResolvers<void>>();
      await queue.createQueue('beats', { heartbeatSeconds: 10, retryDelay: 0 });
      await queue.send('beats', null, { id: id(1) });
      await queue.work('beats', { localConcurrency: 2 }, async ([job]) => {
        const attempt = job?.retryCount ?? -1;
        job?.signal.addEventListener('abort', () => {
          const reason: unknown = job.signal.reason;
          aborts.push({
            attempt,
            at: clock.now() - origin,
            reason: reason instanceof Error ? reason.message : String(reason),
          });
        });
        const release = Promise.withResolvers<void>();
        releases.set(attempt, release);
        await release.promise;
      });
      const read = async () => {
        const [job] = await queue.findJobs('beats');
        return {
          state: job?.state,
          retryCount: job?.retryCount,
          heartbeatOn: job?.heartbeatOn
            ? job.heartbeatOn.getTime() - origin
            : null,
        };
      };
      await flush(clock);
      // An unfenced fail() puts the claimed job back in retry while its
      // handler still runs; the idle loop claims it again at the next poll.
      await queue.fail('beats', id(1));
      await clock.tick(2000);
      await flush(clock);
      const reclaimed = await read();
      await clock.tick(3000);
      await flush(clock);
      const atFirstHeartbeat = { job: await read(), aborts: [...aborts] };
      await clock.tick(2000);
      await flush(clock);
      const atSecondHeartbeat = { job: await read(), aborts: [...aborts] };
      for (const release of releases.values()) {
        release.resolve();
      }
      await flush(clock);
      return {
        reclaimed,
        atFirstHeartbeat,
        atSecondHeartbeat,
        settled: await read(),
      };
    });

    // touch() is fenced to (id, retry_count) of the batch's own claim
    // (plans.js:2387-2400, 2051-2054), so attempt 0's heartbeat at 5000 finds
    // nothing, aborts its claim and leaves attempt 1's heartbeatOn alone;
    // attempt 1's own heartbeat refreshes it at 7000 (manager.js:537-566).
    const lost = {
      attempt: 0,
      at: 5000,
      reason: `job ${id(1)} is no longer active under this worker's claim`,
    };
    assert.deepStrictEqual(observed, {
      reclaimed: { state: 'active', retryCount: 1, heartbeatOn: 2000 },
      atFirstHeartbeat: {
        job: { state: 'active', retryCount: 1, heartbeatOn: 2000 },
        aborts: [lost],
      },
      atSecondHeartbeat: {
        job: { state: 'active', retryCount: 1, heartbeatOn: 7000 },
        aborts: [lost],
      },
      settled: { state: 'completed', retryCount: 1, heartbeatOn: 7000 },
    });
  });

  it('stop touching when a batch ends, so a queue deleted afterwards reports nothing', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        await queue.createQueue('beats', { heartbeatSeconds: 10 });
        await queue.send('beats', null, { id: id(1) });
        await queue.work('beats', async () => {});
        await flush(clock);
        const [job] = await queue.findJobs('beats');
        // Without its worker, no poll reports the deleted queue either.
        await queue.offWork('beats');
        await queue.deleteQueue('beats');
        await clock.tick(10_000);
        await flush(clock);
        return {
          state: job?.state,
          errors: errors.map((error) => error.message),
        };
      },
    );

    // The batch clears its heartbeat timer as it settles (manager.js:656-658).
    assert.deepStrictEqual(observed, { state: 'completed', errors: [] });
  });

  it('report a queue deleted under a per-job batch, and under a batch a stop fails', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        const release = Promise.withResolvers<void>();
        const held = Promise.withResolvers<void>();
        await queue.createQueue('perJob');
        await queue.createQueue('held');
        await queue.send('perJob', null, { id: id(1) });
        await queue.send('held', null, { id: id(2) });
        // Long polls keep both workers waiting after their batches.
        await queue.work(
          'perJob',
          { perJobResults: true, pollingIntervalSeconds: 30 },
          async ([job]) => {
            await release.promise;
            return [{ id: job?.id, status: 'completed' }];
          },
        );
        await queue.work(
          'held',
          { pollingIntervalSeconds: 30 },
          async () => held.promise,
        );
        await flush(clock);
        await queue.deleteQueue('perJob');
        await queue.deleteQueue('held');
        release.resolve();
        await flush(clock);
        const perJob = errors.map((error) => error.message);
        await queue.stop({ graceful: false, close: false });
        held.resolve();
        await flush(clock);
        const alias = (message: string) =>
          message.replace(/Worker: [^)]+/, 'Worker: <worker>');
        return {
          perJob: perJob.map(alias),
          stopped: errors
            .slice(perJob.length)
            .map((error) => alias(error.message)),
        };
      },
    );

    // The completed group and failWip's fail look the queue up first
    // (manager.js:411, 892, 1680): the per-job batch's worker reports it; the
    // stop reports the held batch it could not fail, then that batch's own
    // settle reports it once released. The idle per-job worker is gone by
    // then (index.js:227-233).
    const missing = (name: string) => `Queue ${name} does not exist`;
    const worker = (name: string) =>
      `${missing(name)} (Queue: ${name}, Worker: <worker>)`;
    assert.deepStrictEqual(observed, {
      perJob: [worker('perJob')],
      stopped: [missing('held'), worker('held')],
    });
  });

  it('report a heartbeat that cannot run, and abort nothing for it', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        const aborts: string[] = [];
        const release = Promise.withResolvers<void>();
        await queue.createQueue('beats', { heartbeatSeconds: 10 });
        await queue.send('beats', null, { id: id(1) });
        // A long poll keeps the worker waiting after the batch, so its next
        // fetch does not race the reads below.
        await queue.work(
          'beats',
          { pollingIntervalSeconds: 30 },
          async ([job]) => {
            job?.signal.addEventListener('abort', () => {
              aborts.push(job.id);
            });
            await release.promise;
          },
        );
        await flush(clock);
        await queue.deleteQueue('beats');
        await clock.tick(5000);
        await flush(clock);
        const reported = errors.map((error) => ({
          isError: error instanceof Error,
          keys: Object.keys(error),
          name: error.name,
          message: error.message,
        }));
        const aborted = [...aborts];
        release.resolve();
        await flush(clock);
        // The batch's completion looks the queue up too, and so does the
        // fail it falls back to, so the worker reports the deleted queue.
        const settled = errors
          .slice(reported.length)
          .map((error) =>
            error.message.replace(/Worker: [^)]+/, 'Worker: <worker>'),
          );
        return { reported, aborted, settled };
      },
    );

    // touch() looks the queue up first and throws; the heartbeat emits that
    // error as it is and aborts nothing (manager.js:545-551, 1994-1998).
    assert.deepStrictEqual(observed, {
      reported: [
        {
          isError: true,
          keys: [],
          name: 'Error',
          message: 'Queue beats does not exist',
        },
      ],
      aborted: [],
      settled: ['Queue beats does not exist (Queue: beats, Worker: <worker>)'],
    });
  });
});
