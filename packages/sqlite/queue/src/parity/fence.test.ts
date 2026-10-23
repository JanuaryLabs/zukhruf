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

// What a call did: its result, or the error class and message it rejected with.
async function outcome(call: () => Promise<unknown>) {
  try {
    return await call();
  } catch (error) {
    return error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  }
}

// A settle's result with `settled` sorted: pg-boss aggregates the ids it
// touched in no specified order (plans.js:2413-2415).
function sortSettled(response: unknown) {
  if (
    response === null ||
    typeof response !== 'object' ||
    !('settled' in response) ||
    !Array.isArray(response.settled)
  ) {
    return response;
  }
  return { ...response, settled: response.settled.toSorted() };
}

describe('attempt fence', () => {
  it('settle a batch only at the attempt its worker claimed', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      const releases = new Map<string, PromiseWithResolvers<void>>();
      const settle = (name: string, retryCount: number) =>
        releases.get(`${name}:${retryCount}`)?.resolve();
      for (const name of ['completes', 'throws']) {
        await queue.createQueue(name, { retryLimit: 2 });
        await queue.send(name, null, { id: id(1) });
        await queue.work(name, { localConcurrency: 2 }, async ([job]) => {
          const release = Promise.withResolvers<void>();
          releases.set(`${name}:${job?.retryCount}`, release);
          await release.promise;
          if (name === 'throws' && job?.retryCount === 0) {
            throw new Error('stale');
          }
          return { attempt: job?.retryCount };
        });
      }
      await flush(clock);
      // An unfenced fail() puts each claimed job back in retry while its
      // handler still runs; the idle loop claims it again at the next poll.
      await queue.fail('completes', id(1));
      await queue.fail('throws', id(1));
      await clock.tick(2000);
      await flush(clock);
      const job = async (name: string) => {
        const [found] = await queue.findJobs(name);
        return {
          state: found?.state,
          retryCount: found?.retryCount,
          output: found?.output,
        };
      };
      const reclaimed = {
        completes: await job('completes'),
        throws: await job('throws'),
      };
      settle('completes', 0);
      settle('throws', 0);
      await flush(clock);
      const afterStale = {
        completes: await job('completes'),
        throws: await job('throws'),
      };
      settle('completes', 1);
      settle('throws', 1);
      await flush(clock);
      return {
        reclaimed,
        afterStale,
        afterCurrent: {
          completes: await job('completes'),
          throws: await job('throws'),
        },
      };
    });

    // work() settles with the jobs it claimed, { id, retryCount } each
    // (manager.js:628, 652), so attempt 0's completion and failure match
    // nothing once attempt 1 holds the job (plans.js:2051-2054).
    const active = { state: 'active', retryCount: 1, output: null };
    const completed = {
      state: 'completed',
      retryCount: 1,
      output: { attempt: 1 },
    };
    assert.deepStrictEqual(observed, {
      reclaimed: { completes: active, throws: active },
      afterStale: { completes: active, throws: active },
      afterCurrent: { completes: completed, throws: completed },
    });
  });

  it('let fail() and cancel() take jobs, fenced to the attempt each names', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs', { retryLimit: 2 });
      for (const n of [1, 2, 3, 4]) {
        await queue.send('jobs', null, { id: id(n) });
      }
      const release = Promise.withResolvers<void>();
      await queue.work('jobs', { batchSize: 3 }, async () => release.promise);
      await queue.send('jobs', null, { id: id(5) });
      await flush(clock);
      const results = {
        staleFail: await outcome(() =>
          queue.fail('jobs', { id: id(1), retryCount: 1 }),
        ),
        staleCancel: await outcome(() =>
          queue.cancel('jobs', { id: id(1), retryCount: 1 }),
        ),
        currentFail: await outcome(() =>
          queue.fail('jobs', [{ id: id(2), retryCount: 0 }], { a: 1 }),
        ),
        currentCancel: await outcome(() =>
          queue.cancel('jobs', { id: id(3), retryCount: 0 }),
        ),
        queuedCancel: await outcome(() =>
          queue.cancel('jobs', [{ id: id(5), retryCount: 0 }]),
        ),
        duplicate: await outcome(() => queue.fail('jobs', [id(4), id(4)])),
        emptyId: await outcome(() => queue.fail('jobs', '')),
        noIdsOnMissingQueue: await outcome(() => queue.cancel('missing', [])),
        // A mix arrives the way an untyped caller sends it: as parsed JSON,
        // which the id types cannot reject at compile time.
        mixed: await outcome(() =>
          queue.fail(
            'jobs',
            JSON.parse(JSON.stringify([id(1), { id: id(2), retryCount: 0 }])),
          ),
        ),
        negative: await outcome(() =>
          queue.cancel('jobs', { id: id(1), retryCount: -1 }),
        ),
        fractional: await outcome(() =>
          queue.fail('jobs', { id: id(1), retryCount: 0.5 }),
        ),
        several: sortSettled(
          await outcome(() => queue.cancel('jobs', [id(5), id(4)])),
        ),
      };
      release.resolve();
      await flush(clock);
      const jobs = await queue.findJobs('jobs');
      return {
        results,
        jobs: jobs
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((job) => ({ id: job.id, state: job.state, output: job.output })),
      };
    });

    // mapAttemptArg (manager.js:1596-1605) and the fence, which matches only an
    // active job at the named retryCount (plans.js:2051-2054).
    const requires =
      'AssertionError: fail() requires either ids or jobs with an id and an integer retryCount, not a mix';
    assert.deepStrictEqual(observed, {
      results: {
        staleFail: { jobs: [id(1)], requested: 1, affected: 0, settled: [] },
        staleCancel: { jobs: [id(1)], requested: 1, affected: 0, settled: [] },
        currentFail: {
          jobs: [id(2)],
          requested: 1,
          affected: 1,
          settled: [id(2)],
        },
        currentCancel: {
          jobs: [id(3)],
          requested: 1,
          affected: 1,
          settled: [id(3)],
        },
        queuedCancel: { jobs: [id(5)], requested: 1, affected: 0, settled: [] },
        // Each id is settled once (plans.js:2413-2415).
        duplicate: {
          jobs: [id(4), id(4)],
          requested: 2,
          affected: 1,
          settled: [id(4)],
        },
        emptyId: 'AssertionError: fail() requires an id',
        // The ids are checked before the queue (manager.js:1957-1959).
        noIdsOnMissingQueue: 'AssertionError: cancel() requires an id',
        mixed: requires,
        negative: requires.replace('fail()', 'cancel()'),
        fractional: requires,
        several: {
          jobs: [id(5), id(4)],
          requested: 2,
          affected: 2,
          settled: [id(4), id(5)],
        },
      },
      jobs: [
        { id: id(1), state: 'completed', output: null },
        { id: id(2), state: 'retry', output: { a: 1 } },
        { id: id(3), state: 'cancelled', output: null },
        { id: id(4), state: 'cancelled', output: null },
        { id: id(5), state: 'cancelled', output: null },
      ],
    });
  });
});
