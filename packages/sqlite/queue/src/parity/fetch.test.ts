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

describe('fetch', () => {
  it('takes jobs by priority then creation, ignoring the deprecated sort options and ignoreStartAfter', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      const warnings: string[] = [];
      const onWarning = (warning: Error) => {
        if ('code' in warning && warning.code === 'PGBOSS_DEP_FETCH_SORT') {
          warnings.push(warning.message);
        }
      };
      process.on('warning', onWarning);
      try {
        await queue.start();
        await queue.createQueue('jobs');
        // Sent in this order, a millisecond apart: ids say nothing about it.
        const sends: [number, number][] = [
          [4, 0],
          [3, 1],
          [2, 0],
          [1, 1],
        ];
        for (const [index, [n, priority]] of sends.entries()) {
          await clock.setTime(Date.parse(ParityRun.start) + index);
          await queue.send('jobs', null, { id: id(n), priority });
        }
        await queue.send('jobs', null, { id: id(5), startAfter: 60 });

        const ran: string[] = [];
        await queue.work(
          'jobs',
          { priority: false, orderByCreatedOn: false, ignoreStartAfter: true },
          async ([job]) => {
            ran.push(job?.id ?? '');
          },
        );
        await flush(clock);
        for (let polls = 0; polls < 6; polls++) {
          await clock.tick(2000);
          await flush(clock);
        }
        return { ran, warnings: warnings.sort() };
      } finally {
        process.off('warning', onWarning);
      }
    });

    // Always `ORDER BY priority desc, created_on` (node_modules/pg-boss/dist/
    // plans.js:1947-1970); work() never forwards ignoreStartAfter
    // (manager.js:951-956) and warns once per deprecated sort option
    // (manager.js:1552-1559).
    assert.deepStrictEqual(observed, {
      ran: [id(3), id(1), id(4), id(2)],
      warnings: [
        'orderByCreatedOn: false is deprecated and now ignored. Jobs are always fetched in priority and creation order. Remove it; it will be rejected in the next major.',
        'priority: false is deprecated and now ignored. Jobs are always fetched in priority and creation order. Remove it; it will be rejected in the next major.',
      ],
    });
  });

  it('takes only jobs within minPriority and maxPriority', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      for (const priority of [0, 1, 2, 3]) {
        await queue.send('jobs', null, { id: id(priority + 1), priority });
      }
      const ran: string[] = [];
      await queue.work(
        'jobs',
        { batchSize: 10, minPriority: 1, maxPriority: 2 },
        async (jobs) => {
          ran.push(...jobs.map((job) => job.id));
        },
      );
      await flush(clock);
      return ran.sort();
    });

    // node_modules/pg-boss/dist/plans.js:1943-1944.
    assert.deepStrictEqual(observed, [id(2), id(3)]);
  });

  it('read the options once at work(), and warn only for a sort option set to false', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      const warnings: string[] = [];
      const onWarning = (warning: Error) => {
        if ('code' in warning && warning.code === 'PGBOSS_DEP_FETCH_SORT') {
          warnings.push(warning.message);
        }
      };
      process.on('warning', onWarning);
      try {
        await queue.start();
        await queue.createQueue('jobs');
        for (const n of [1, 2, 3]) {
          await queue.send('jobs', null, { id: id(n) });
        }
        const batches: number[] = [];
        const options = {
          batchSize: 1,
          priority: true,
          orderByCreatedOn: true,
        };
        await queue.work('jobs', options, async (jobs) => {
          batches.push(jobs.length);
        });
        // Too late: pg-boss copied and destructured the options at work().
        options.batchSize = 10;
        await flush(clock);
        for (let polls = 0; polls < 3; polls++) {
          await clock.tick(2000);
          await flush(clock);
        }
        return { batches, warnings };
      } finally {
        process.off('warning', onWarning);
      }
    });

    // attorney.js:370 copies the options and manager.js:915 destructures
    // them; manager.js:1554 warns only for `=== false`.
    assert.deepStrictEqual(observed, { batches: [1, 1, 1], warnings: [] });
  });

  it('hand a whole batch to the handler in one call', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      for (const [index, [n, priority]] of (
        [
          [4, 0],
          [3, 1],
          [2, 0],
          [1, 1],
        ] as const
      ).entries()) {
        await clock.setTime(Date.parse(ParityRun.start) + index);
        await queue.send('jobs', null, { id: id(n ?? 0), priority });
      }
      const batches: string[][] = [];
      await queue.work('jobs', { batchSize: 10 }, async (jobs) => {
        batches.push(jobs.map((job) => job.id).sort());
      });
      await flush(clock);
      return batches;
    });

    // Sorted: pg-boss's `UPDATE ... RETURNING` has no ORDER BY
    // (node_modules/pg-boss/dist/plans.js:2019-2028), so the order inside a
    // batch is the planner's (claim order on an analyzed Postgres, id order on
    // PGlite's unanalyzed tables).
    assert.deepStrictEqual(observed, [[id(1), id(2), id(3), id(4)]]);
  });
});
