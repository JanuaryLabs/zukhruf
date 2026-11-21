import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { QueueStatsOptions } from 'pg-boss';

import type { JobQueue } from '../index.ts';
import { id } from '../testing/job-id.ts';
import { outcome } from '../testing/outcome.ts';
import { supervised } from '../testing/supervised.ts';
import { ParityRun } from './backends.ts';
import { Parity } from './parity.ts';

const origin = Date.parse(ParityRun.start);
const hour = 3600 * 1000;

// The snapshots a read gives, with capturedOn in ms since the clock's start.
async function stats(
  queue: JobQueue,
  name: string,
  options?: QueueStatsOptions,
) {
  const snapshots = await queue.getQueueStats(name, options);
  return snapshots.map((snapshot) => ({
    ...snapshot,
    capturedOn:
      snapshot.capturedOn instanceof Date
        ? snapshot.capturedOn.getTime() - origin
        : `not a Date: ${String(snapshot.capturedOn)}`,
  }));
}

// The queued count and capturedOn of each read, in order.
function readings(reads: Awaited<ReturnType<typeof stats>>[]) {
  return reads.map((snapshots) =>
    snapshots.map(({ queuedCount, capturedOn }) => [queuedCount, capturedOn]),
  );
}

// A fetch that must give exactly the job `n`.
async function fetchJob(queue: JobQueue, name: string, n: number) {
  const fetched = await queue.fetch(name);
  assert.deepStrictEqual(
    fetched.map((job) => job.id),
    [id(n)],
  );
}

// Two jobs, each due now: a read that counts again sees them, and a read of
// the cache does not.
async function sendTwo(queue: JobQueue, name: string, base: number) {
  await queue.send(name, null, { id: id(base) });
  await queue.send(name, null, { id: id(base + 1) });
}

describe('getQueueStats()', () => {
  it('refuses a name that is not a queue name and a queue that does not exist, with the errors of pg-boss', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      // The arguments of each refused call, as an untyped caller sends them.
      const refused: Record<string, unknown[]> = {
        noName: [],
        emptyName: [''],
        badName: ['a b'],
        notText: [123],
        missingQueue: ['missing'],
        missingQueueForced: ['missing', { force: true }],
      };
      const refusals: Record<string, string> = {};
      for (const [key, args] of Object.entries(refused)) {
        refusals[key] = await outcome(() =>
          Reflect.apply(queue.getQueueStats, queue, args),
        );
      }
      return refusals;
    });

    // manager.js:2612, 2697
    assert.equal(observed.missingQueue, 'Error: Queue missing does not exist');
    assert.equal(observed.missingQueueForced, observed.missingQueue);
    assert.equal(Object.values(observed).includes('resolved'), false);
  });

  it('counts a queue on its first read: an empty queue, and a queue with a job in each state', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('empty');
      await queue.createQueue('jobs');
      await queue.send('jobs', null, { id: id(1), retryLimit: 0 });
      await fetchJob(queue, 'jobs', 1);
      await queue.fail('jobs', id(1));
      await queue.send('jobs', null, { id: id(2) });
      await fetchJob(queue, 'jobs', 2);
      await queue.complete('jobs', id(2));
      await queue.send('jobs', null, { id: id(3) });
      await fetchJob(queue, 'jobs', 3);
      await queue.cancel('jobs', id(3));
      // A failed attempt with a retry delay: queued and deferred.
      await queue.send('jobs', null, { id: id(4), retryDelay: 600 });
      await fetchJob(queue, 'jobs', 4);
      await queue.fail('jobs', id(4));
      await queue.send('jobs', null, { id: id(5) });
      await fetchJob(queue, 'jobs', 5);
      await queue.send('jobs', null, { id: id(6) });
      await queue.send('jobs', null, { id: id(7), startAfter: 600 });
      return {
        empty: await stats(queue, 'empty'),
        jobs: await stats(queue, 'jobs'),
      };
    });

    const empty = {
      name: 'empty',
      deferredCount: 0,
      queuedCount: 0,
      readyCount: 0,
      activeCount: 0,
      failedCount: 0,
      totalCount: 0,
      completedDelta: null,
      failedDelta: null,
      createdDelta: null,
      deltaSeconds: null,
      deltaOn: null,
      // Uncounted with persistQueueStats off (12.36.0: manager.js:2620-2666).
      waitBins: null,
      runBins: null,
      readyOldestSeconds: null,
      capturedOn: 0,
    };
    assert.deepStrictEqual(observed, {
      empty: [empty],
      jobs: [
        {
          ...empty,
          name: 'jobs',
          deferredCount: 2,
          queuedCount: 3,
          readyCount: 1,
          activeCount: 1,
          failedCount: 1,
          // The live jobs only: no maintenance pass has counted the completed
          // and cancelled ones into retained_count yet (12.38.0:
          // plans.js:324-331, 4372).
          totalCount: 5,
        },
      ],
    });
  });

  it('serves the counts of a read for an hour, then counts again and serves the new counts', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      const first = await stats(queue, 'jobs');
      await sendTwo(queue, 'jobs', 1);
      await clock.tick(hour);
      const atAnHour = await stats(queue, 'jobs');
      await clock.tick(1);
      const pastAnHour = await stats(queue, 'jobs');
      await sendTwo(queue, 'jobs', 3);
      await clock.tick(1000);
      const afterRecount = await stats(queue, 'jobs');
      return { first, atAnHour, pastAnHour, afterRecount };
    });

    const counted = (n: number, capturedOn: number) => [
      {
        ...observed.first[0],
        queuedCount: n,
        readyCount: n,
        totalCount: n,
        capturedOn,
      },
    ];
    assert.deepStrictEqual(observed.first, counted(0, 0));
    assert.deepStrictEqual(observed.atAnHour, counted(0, 0));
    assert.deepStrictEqual(observed.pastAnHour, counted(2, hour + 1));
    assert.deepStrictEqual(observed.afterRecount, counted(2, hour + 1));
  });

  for (const option of [
    'monitorIntervalSeconds',
    'superviseIntervalSeconds',
  ] as const) {
    it(`serves the counts of a read for ${option} when it is longer than an hour`, async () => {
      const observed = await Parity.assertSame(
        async ({ queue, clock }) => {
          await queue.start();
          await queue.createQueue('jobs');
          await stats(queue, 'jobs');
          await sendTwo(queue, 'jobs', 1);
          await clock.tick(hour + 1);
          const pastAnHour = await stats(queue, 'jobs');
          await clock.tick(hour - 1);
          const atTheInterval = await stats(queue, 'jobs');
          await clock.tick(1);
          const pastTheInterval = await stats(queue, 'jobs');
          return readings([pastAnHour, atTheInterval, pastTheInterval]);
        },
        { [option]: 7200 },
      );

      assert.deepStrictEqual(observed, [
        [[0, 0]],
        [[0, 0]],
        [[2, 2 * hour + 1]],
      ]);
    });
  }

  it('with force, serves counts at most a minute old, then counts again, also when the intervals are longer than a minute', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock }) => {
        await queue.start();
        await queue.createQueue('jobs');
        await stats(queue, 'jobs');
        await sendTwo(queue, 'jobs', 1);
        await clock.tick(60_000);
        const forcedAtAMinute = await stats(queue, 'jobs', { force: true });
        await clock.tick(1);
        const unforced = await stats(queue, 'jobs');
        const forcedPastAMinute = await stats(queue, 'jobs', { force: true });
        await sendTwo(queue, 'jobs', 3);
        await clock.tick(30_000);
        const forcedAfterRecount = await stats(queue, 'jobs', {
          force: true,
        });
        return readings([
          forcedAtAMinute,
          unforced,
          forcedPastAMinute,
          forcedAfterRecount,
        ]);
      },
      { monitorIntervalSeconds: 7200, superviseIntervalSeconds: 7200 },
    );

    assert.deepStrictEqual(observed, [
      [[0, 0]],
      [[0, 0]],
      [[2, 60_001]],
      [[2, 60_001]],
    ]);
  });

  it('checks percentiles after the name and before the queue, and gives each snapshot one entry per percent, uncounted', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      // Plain values, as an untyped caller sends them, so ones the option
      // types exclude reach both.
      const read = async (name: string, percentiles: unknown) => {
        const snapshots: unknown = await Reflect.apply(
          queue.getQueueStats,
          queue,
          [name, { percentiles }],
        );
        assert.ok(Array.isArray(snapshots));
        return snapshots.map((snapshot: object) =>
          Reflect.get(snapshot, 'percentiles'),
        );
      };
      return {
        zero: await outcome(() => read('jobs', [0])),
        overHundred: await outcome(() => read('jobs', [101])),
        empty: await outcome(() => read('jobs', [])),
        text: await outcome(() => read('jobs', ['50'])),
        missingQueue: await outcome(() => read('missing', [0])),
        badName: await outcome(() => read('', [0])),
        listed: await read('jobs', [95, 50, 95]),
        none: await read('jobs', undefined),
      };
    });

    // manager.js:2611-2616, 2659-2665 (12.36.0): the name first, then the
    // percents, then the queue; with persistQueueStats off the snapshot has no
    // histograms, so each percentile reads null.
    const refused =
      'AssertionError: getQueueStats: percentiles must be a non-empty array of percents from 1 to 100, such as [50, 95]';
    assert.deepStrictEqual(observed, {
      zero: refused,
      overHundred: refused,
      empty: refused,
      text: refused,
      missingQueue: refused,
      badName: 'AssertionError: Name is required',
      listed: [
        [
          { p: 95, waitSeconds: null, runSeconds: null },
          { p: 50, waitSeconds: null, runSeconds: null },
        ],
      ],
      none: [undefined],
    });
  });

  it('ignores and checks none of the history options, which only persistQueueStats reads', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', null, { id: id(1) });
      // A value each history check of pg-boss refuses (manager.js:2672-2679),
      // as an untyped caller sends them.
      const history = {
        from: new Date(origin + hour),
        to: new Date(origin),
        limit: 0,
        bucketSeconds: -1,
        maxDataPoints: 0.5,
        aggregate: 'median',
      };
      const read = async () => {
        try {
          return await Reflect.apply(stats, undefined, [
            queue,
            'jobs',
            history,
          ]);
        } catch (error) {
          return String(error);
        }
      };
      const counted = await read();
      await queue.send('jobs', null, { id: id(2) });
      await clock.tick(1000);
      const cached = await read();
      return { counted, cached };
    });

    assert.deepStrictEqual(observed.cached, observed.counted);
    assert.ok(Array.isArray(observed.counted), String(observed.counted));
    assert.deepStrictEqual(readings([observed.counted]), [[[1, 0]]]);
  });

  it('serves the counts that a supervise pass wrote', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await sendTwo(queue, 'jobs', 1);
      await queue.send('jobs', null, { id: id(3), startAfter: 600 });
      await fetchJob(queue, 'jobs', 1);
      await clock.tick(1000);
      await queue.send('jobs', null, { id: id(4) });
      return stats(queue, 'jobs');
    }, supervised);

    assert.deepStrictEqual(observed, [
      {
        name: 'jobs',
        deferredCount: 1,
        queuedCount: 2,
        readyCount: 1,
        activeCount: 1,
        failedCount: 0,
        totalCount: 3,
        completedDelta: null,
        failedDelta: null,
        createdDelta: null,
        deltaSeconds: null,
        deltaOn: null,
        waitBins: null,
        runBins: null,
        readyOldestSeconds: null,
        capturedOn: 1000,
      },
    ]);
  });
});
