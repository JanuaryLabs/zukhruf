import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type SendOptions, policies } from 'pg-boss';

import type { JobQueue } from '../index.ts';
import { id } from '../testing/job-id.ts';
import { outcome } from '../testing/outcome.ts';
import { ParityRun, type RunOptions } from './backends.ts';
import { Observe } from './observe.ts';
import { Parity } from './parity.ts';

const origin = Date.parse(ParityRun.start);

// Every supervisor timer at its 1 s minimum, so each second's tick runs a
// cache refresh and a supervise pass that monitors and maintains every queue.
const supervised = {
  supervise: true,
  superviseIntervalSeconds: 1,
  monitorIntervalSeconds: 1,
  maintenanceIntervalSeconds: 1,
  queueCacheIntervalSeconds: 1,
} satisfies RunOptions;

// { ...options, singletonKey }: pg-boss reads an undefined key as no key,
// which its types cannot hold under exactOptionalPropertyTypes.
const keyed = (options: SendOptions, singletonKey: string | undefined) => {
  Reflect.set(options, 'singletonKey', singletonKey);
  return options;
};

// The ids of a batch, sorted: pg-boss's `UPDATE ... RETURNING` has no ORDER
// BY (node_modules/pg-boss/dist/plans.js:2019-2028), so the order inside a
// batch is the planner's.
const ids = (jobs: { id: string }[]) => jobs.map((job) => job.id).sort();

// The fields a claim and a settle write on a job.
async function attempt(queue: JobQueue, name: string, n: number) {
  const [job] = await queue.findJobs(name, { id: id(n) });
  assert.ok(job, `job ${n} is missing`);
  const { state, retryCount, startedOn, heartbeatOn } = Observe.job(job);
  return { state, retryCount, startedOn, heartbeatOn };
}

// A settle's result with `settled` sorted: pg-boss aggregates the ids it
// touched in no specified order (plans.js:2413-2415).
const sortSettled = <T extends { settled?: string[] }>(response: T) => ({
  ...response,
  settled: response.settled?.toSorted(),
});

// What a fetch with options that the types refuse did.
const refused = (queue: JobQueue, name: unknown, options?: unknown) =>
  outcome(() => Reflect.apply(queue.fetch, queue, [name, options]));

const sortWarning =
  'is deprecated and now ignored. Jobs are always fetched in priority and creation order. Remove it; it will be rejected in the next major.';

describe('fetch()', () => {
  it('gives no job from an empty queue, then one job for each call, with the minimal fields and no signal', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      const empty = await queue.fetch('jobs');
      for (const n of [1, 2, 3]) {
        await clock.setTime(origin + n);
        await queue.send('jobs', { n }, { id: id(n) });
      }
      const first = await queue.fetch('jobs');
      const second = await queue.fetch('jobs', {});
      return {
        empty,
        first: first.map((job) => ({
          keys: Object.keys(job).sort(),
          job: Observe.job(job),
        })),
        second: second.map((job) => job.id),
      };
    });

    // limit: options.batchSize || 1 (node_modules/pg-boss/dist/
    // manager.js:1571), JOB_COLUMNS_MIN (plans.js:591, 2028), and no signal:
    // only a worker adds one (manager.js:530).
    assert.deepStrictEqual(observed, {
      empty: [],
      first: [
        {
          keys: [
            'data',
            'expireInSeconds',
            'groupId',
            'groupTier',
            'heartbeatSeconds',
            'id',
            'name',
            'retryCount',
          ],
          job: {
            data: { n: 1 },
            expireInSeconds: 900,
            groupId: null,
            groupTier: null,
            heartbeatSeconds: null,
            id: id(1),
            name: 'jobs',
            retryCount: 0,
          },
        },
      ],
      second: [id(2)],
    });
  });

  it('takes a batch of batchSize jobs by priority, then by creation, and leaves a deferred job', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
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
        await clock.setTime(origin + index);
        await queue.send('jobs', null, { id: id(n), priority });
      }
      await queue.send('jobs', null, { id: id(5), startAfter: 60 });
      // The deprecated sort options change nothing.
      const unsorted = { priority: false, orderByCreatedOn: false };
      return {
        first: ids(await queue.fetch('jobs', { batchSize: 1, ...unsorted })),
        second: ids(await queue.fetch('jobs', { batchSize: 2 })),
        third: ids(await queue.fetch('jobs', { batchSize: 3, ...unsorted })),
        fourth: ids(await queue.fetch('jobs', { batchSize: 3 })),
      };
    });

    // `ORDER BY priority desc, created_on` and the LIMIT (plans.js:1947-1970).
    // The order of the ids in one batch is not compared: see `ids`.
    assert.deepStrictEqual(observed, {
      first: [id(3)],
      second: [id(1), id(4)],
      third: [id(2)],
      fourth: [],
    });
  });

  it('takes a deferred job only with ignoreStartAfter, also as the head of its key on a key_strict_fifo queue', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', null, { id: id(1), startAfter: 60 });
      const plain = {
        byDefault: ids(await queue.fetch('jobs')),
        whenFalse: ids(await queue.fetch('jobs', { ignoreStartAfter: false })),
        whenTrue: ids(await queue.fetch('jobs', { ignoreStartAfter: true })),
        after: await attempt(queue, 'jobs', 1),
      };
      // One key on each queue: a deferred job first, then a due job.
      let n = 1;
      const heads: Record<string, string[]> = {};
      for (const ignoreStartAfter of [false, true]) {
        const name = `fifo-${ignoreStartAfter}`;
        await queue.createQueue(name, { policy: policies.key_strict_fifo });
        await clock.setTime(origin + n);
        await queue.send(name, null, {
          id: id(++n),
          singletonKey: 'a',
          startAfter: 60,
        });
        await clock.setTime(origin + n);
        await queue.send(name, null, { id: id(++n), singletonKey: 'a' });
        heads[name] = ids(
          await queue.fetch(name, { batchSize: 10, ignoreStartAfter }),
        );
      }
      return { plain, heads };
    });

    // plans.js:1928, and 1915 for the head of a key.
    assert.deepStrictEqual(observed, {
      plain: {
        byDefault: [],
        whenFalse: [],
        whenTrue: [id(1)],
        after: { state: 'active', retryCount: 0, startedOn: 0, heartbeatOn: 0 },
      },
      heads: { 'fifo-false': [id(3)], 'fifo-true': [id(4)] },
    });
  });

  it('gives all the fields of an active job with includeMetadata, and still no signal', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs', { heartbeatSeconds: 30, retryLimit: 3 });
      await queue.send(
        'jobs',
        { n: 1 },
        { id: id(1), priority: 2, singletonKey: 'k', group: { id: 'g' } },
      );
      await clock.setTime(origin + 5000);
      const jobs = await queue.fetch('jobs', { includeMetadata: true });
      return jobs.map((job) => ({
        keys: Object.keys(job).sort(),
        state: job.state,
        startedOn: job.startedOn.getTime() - origin,
        job: Observe.job(job),
      }));
    });

    // JOB_COLUMNS_ALL (plans.js:592-620, 2028), as the claim wrote the row
    // (2019-2023).
    assert.strictEqual(observed.length, 1);
    assert.partialDeepStrictEqual(observed[0], {
      state: 'active',
      startedOn: 5000,
      job: {
        id: id(1),
        retryCount: 0,
        heartbeatOn: 5000,
        createdOn: 0,
        completedOn: null,
        priority: 2,
        singletonKey: 'k',
        groupId: 'g',
        output: null,
      },
    });
    assert.ok(!observed[0]?.keys.includes('signal'));
    assert.ok(observed[0]?.keys.includes('sourceRootId'));
  });

  it('claims a failed job again with one more retryCount, until its retries are used, and fences a settle to the fetched attempt', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs', { retryLimit: 2 });
      await queue.send('jobs', null, { id: id(1) });
      const attempts = [];
      let stale = null;
      for (let round = 1; round <= 5; round++) {
        await clock.setTime(origin + round * 1000);
        const jobs = await queue.fetch('jobs');
        const [job] = jobs;
        if (!job) {
          attempts.push({ fetched: [] });
          break;
        }
        const claimed = await attempt(queue, 'jobs', 1);
        // The job of the first fetch settles nothing once the job has been
        // claimed again.
        if (round === 2 && stale) {
          attempts.push({
            staleFail: sortSettled(await queue.fail('jobs', stale)),
          });
        }
        stale ??= job;
        attempts.push({
          fetched: jobs.map(({ id: jobId, retryCount }) => ({
            id: jobId,
            retryCount,
          })),
          claimed,
          fail: sortSettled(await queue.fail('jobs', job, { round })),
          failed: await attempt(queue, 'jobs', 1),
        });
      }
      return attempts;
    });

    // retry_count + 1 when the job was started before (plans.js:2019-2023);
    // the attempt fence (manager.js:1596-1606).
    const round = (retryCount: number, at: number, state: string) => ({
      fetched: [{ id: id(1), retryCount }],
      claimed: { state: 'active', retryCount, startedOn: at, heartbeatOn: at },
      fail: { jobs: [id(1)], requested: 1, affected: 1, settled: [id(1)] },
      failed: { state, retryCount, startedOn: at, heartbeatOn: null },
    });
    assert.deepStrictEqual(observed, [
      round(0, 1000, 'retry'),
      {
        staleFail: { jobs: [id(1)], requested: 1, affected: 0, settled: [] },
      },
      round(1, 2000, 'retry'),
      round(2, 3000, 'failed'),
      { fetched: [] },
    ]);
  });

  it('fetches on each policy queue as pg-boss does: one job for each key in a singleton or stately batch, the head of each key on key_strict_fifo', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      const results: Record<string, Record<string, string[]>> = {};
      let n = 0;
      for (const policy of Object.values(policies)) {
        await queue.createQueue(policy, { policy });
        const send = async (singletonKey: string | undefined) => {
          await clock.setTime(origin + ++n);
          const options = keyed({ id: id(n) }, singletonKey);
          return outcome(() => queue.send(policy, null, options));
        };
        // The key of each job of a batch, sorted. Which job of a key a
        // singleton or stately batch takes is not specified: pg-boss ranks
        // them with no ORDER BY (plans.js:1971-1975).
        const keys = async (jobs: { id: string }[]) => {
          const found = await queue.findJobs(policy);
          return jobs
            .map(
              (job) =>
                found.find(({ id: jobId }) => jobId === job.id)?.singletonKey,
            )
            .map(String)
            .sort();
        };
        const sentFirst = await Array.fromAsync(
          ['a', 'a', 'b', undefined, undefined],
          send,
        );
        const first = await queue.fetch(policy, { batchSize: 10 });
        const sentSecond = await Array.fromAsync(['a', 'b', undefined], send);
        const second = await queue.fetch(policy, { batchSize: 10 });
        // Unfenced: the first batch goes back to retry beside the new jobs.
        const failed = await outcome(() =>
          queue.fail(
            policy,
            first.map((job) => job.id),
          ),
        );
        const third = await queue.fetch(policy, { batchSize: 10 });
        results[policy] = {
          sent: [...sentFirst, ...sentSecond],
          first: await keys(first),
          second: await keys(second),
          failed: [failed],
          third: await keys(third),
          // created and retry read as one: the batch may take either.
          states: (await queue.findJobs(policy))
            .map(
              (job) =>
                `${job.singletonKey} ${job.state === 'active' ? 'active' : 'queued'}`,
            )
            .sort(),
        };
      }
      return results;
    });

    // The claim of a singleton or stately batch takes one job of each key
    // (plans.js:1842, 1971-1975, 2026); key_strict_fifo takes heads only
    // (1907-1939).
    const batches = Object.fromEntries(
      Object.entries(observed).map(([policy, { first, second, third }]) => [
        policy,
        { first, second, third },
      ]),
    );
    const onePerKey = ['a', 'b', 'null'];
    assert.deepStrictEqual(batches, {
      standard: {
        first: ['a', 'a', 'b', 'null', 'null'],
        second: onePerKey,
        third: ['a', 'a', 'b', 'null', 'null'],
      },
      short: { first: onePerKey, second: onePerKey, third: onePerKey },
      singleton: { first: onePerKey, second: [], third: onePerKey },
      stately: { first: onePerKey, second: [], third: onePerKey },
      exclusive: { first: onePerKey, second: [], third: onePerKey },
      key_strict_fifo: { first: ['a', 'b'], second: [], third: ['a', 'b'] },
    });
  });

  it('skips the singleton key that the supervisor last counted as active', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        await queue.createQueue('jobs', { policy: policies.singleton });
        await queue.send('jobs', null, { id: id(1), singletonKey: 'k1' });
        const held = ids(await queue.fetch('jobs'));
        await queue.send('jobs', null, { id: id(2), singletonKey: 'k1' });
        await queue.send('jobs', null, { id: id(3), singletonKey: 'k2' });
        // Both keys are candidates, and the index refuses the claim of k1.
        const beforeThePass = ids(await queue.fetch('jobs', { batchSize: 2 }));
        await clock.tick(1000);
        await clock.tick(1000);
        const afterThePass = ids(await queue.fetch('jobs', { batchSize: 2 }));
        return {
          held,
          beforeThePass,
          afterThePass,
          errors: errors.map((error) => error.message),
        };
      },
      supervised,
    );

    // ignoreSingletons: singletonsActive (manager.js:1564-1572,
    // plans.js:1941); a unique violation is an empty fetch
    // (manager.js:1580-1586).
    assert.deepStrictEqual(observed, {
      held: [id(1)],
      beforeThePass: [],
      afterThePass: [id(3)],
      errors: [],
    });
  });

  it('limits a batch by groupConcurrency and its tiers, and skips ignoreGroups', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      const groups = [
        [1, 'g1'],
        [2, 'g1'],
        [3, 'g1'],
        [4, 'g2'],
        [5, undefined],
        [6, 'g3'],
        [7, 'g3'],
      ] as const;
      for (const [n, group] of groups) {
        await queue.send('jobs', null, {
          id: id(n),
          ...(group === 'g3' && { group: { id: group, tier: 'gold' } }),
          ...(group && group !== 'g3' && { group: { id: group } }),
        });
      }
      return {
        ignored: ids(
          await queue.fetch('jobs', {
            batchSize: 10,
            ignoreGroups: ['g1', 'g3'],
          }),
        ),
        limited: ids(
          await queue.fetch('jobs', { batchSize: 10, groupConcurrency: 1 }),
        ),
        tiers: ids(
          await queue.fetch('jobs', {
            batchSize: 10,
            groupConcurrency: { default: 1, tiers: { gold: 2 } },
          }),
        ),
        unlimited: ids(
          await queue.fetch('jobs', { batchSize: 10, ignoreGroups: null }),
        ),
      };
    });

    // plans.js:1942 for ignoreGroups; 1857-1900 and 1981-1994 for the limits.
    assert.deepStrictEqual(observed, {
      ignored: [id(4), id(5)],
      limited: [id(1), id(6)],
      tiers: [id(7)],
      unlimited: [id(2), id(3)],
    });
  });

  it('takes only the jobs within minPriority and maxPriority', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      for (const priority of [0, 1, 2, 3]) {
        await queue.send('jobs', null, { id: id(priority + 1), priority });
      }
      return {
        between: ids(
          await queue.fetch('jobs', {
            batchSize: 10,
            minPriority: 1,
            maxPriority: 2,
          }),
        ),
        atMost: ids(
          await queue.fetch('jobs', { batchSize: 10, maxPriority: 0 }),
        ),
        atLeast: ids(
          await queue.fetch('jobs', { batchSize: 10, minPriority: 3 }),
        ),
      };
    });

    // plans.js:1943-1944.
    assert.deepStrictEqual(observed, {
      between: [id(2), id(3)],
      atMost: [id(1)],
      atLeast: [id(4)],
    });
  });

  it('refuses the arguments that pg-boss refuses, with its messages, and claims nothing', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', null, { id: id(1) });
      return {
        noName: await refused(queue, ''),
        noQueue: await refused(queue, 'missing'),
        nullOptions: await refused(queue, 'jobs', null),
        batchSizeZero: await refused(queue, 'jobs', { batchSize: 0 }),
        batchSizeFraction: await refused(queue, 'jobs', { batchSize: 1.5 }),
        batchSizeUndefined: await refused(queue, 'jobs', {
          batchSize: undefined,
        }),
        includeMetadata: await refused(queue, 'jobs', { includeMetadata: 1 }),
        priority: await refused(queue, 'jobs', { priority: 1 }),
        ignoreStartAfter: await refused(queue, 'jobs', { ignoreStartAfter: 1 }),
        minPriority: await refused(queue, 'jobs', { minPriority: 1.5 }),
        maxPriority: await refused(queue, 'jobs', { maxPriority: null }),
        range: await refused(queue, 'jobs', { minPriority: 2, maxPriority: 1 }),
        state: await attempt(queue, 'jobs', 1),
      };
    });

    // attorney.js:399-406, manager.js:849-861.
    assert.partialDeepStrictEqual(observed, {
      noName: 'AssertionError: missing queue name',
      noQueue: 'Error: Queue missing does not exist',
      batchSizeZero: 'AssertionError: batchSize must be an integer > 0',
      batchSizeFraction: 'AssertionError: batchSize must be an integer > 0',
      batchSizeUndefined: 'AssertionError: batchSize must be an integer > 0',
      includeMetadata: 'AssertionError: includeMetadata must be a boolean',
      priority: 'AssertionError: priority must be a boolean',
      ignoreStartAfter: 'AssertionError: ignoreStartAfter must be a boolean',
      minPriority: 'AssertionError: minPriority must be an integer',
      maxPriority: 'AssertionError: maxPriority must be an integer',
      range: 'AssertionError: minPriority must be <= maxPriority',
      state: { state: 'created', retryCount: 0 },
    });
  });

  it('warns one time for each deprecated sort option set to false, for fetch and work together', async () => {
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
        await queue.fetch('jobs', { priority: true, orderByCreatedOn: true });
        const whenTrue = [...warnings];
        await queue.fetch('jobs', { priority: false });
        await queue.fetch('jobs', { priority: false, orderByCreatedOn: false });
        // process.emitWarning delivers on the next tick.
        await clock.tick(0);
        const afterFetch = [...warnings];
        await queue.work(
          'jobs',
          { priority: false, orderByCreatedOn: false },
          async () => {},
        );
        await clock.tick(2000);
        // process.emitWarning delivers on the next tick.
        await clock.tick(0);
        return { whenTrue, afterFetch, afterWork: warnings };
      } finally {
        process.off('warning', onWarning);
      }
    });

    // manager.js:1552-1559, 1562.
    const both = [
      `priority: false ${sortWarning}`,
      `orderByCreatedOn: false ${sortWarning}`,
    ];
    assert.deepStrictEqual(observed, {
      whenTrue: [],
      afterFetch: both,
      afterWork: both,
    });
  });

  it('leaves a fetched job active through stop() and a restart', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', null, { id: id(1) });
      const fetched = ids(await queue.fetch('jobs'));
      await queue.stop({ close: false });
      const whileStopped = ids(await queue.fetch('jobs'));
      await queue.start();
      return {
        fetched,
        whileStopped,
        afterRestart: await attempt(queue, 'jobs', 1),
        again: ids(await queue.fetch('jobs')),
      };
    });

    // Only the jobs of a worker fail at stop (manager.js:866-905), and a
    // fetch still answers while the database stays open.
    assert.deepStrictEqual(observed, {
      fetched: [id(1)],
      whileStopped: [],
      afterRestart: {
        state: 'active',
        retryCount: 0,
        startedOn: 0,
        heartbeatOn: 0,
      },
      again: [],
    });
  });

  it('gives a fetched job back to retry once the supervisor finds it past its expiry, and fails it after its last attempt', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        await queue.createQueue('jobs', { retryLimit: 1 });
        await queue.send('jobs', null, { id: id(1), expireInSeconds: 1 });
        const [first] = await queue.fetch('jobs');
        assert.ok(first, 'the job was not fetched');
        const timeline = [];
        for (const step of [1000, 1000]) {
          await clock.tick(step);
          timeline.push({
            at: clock.now() - origin,
            job: await attempt(queue, 'jobs', 1),
          });
        }
        const second = await queue.fetch('jobs');
        const staleFail = sortSettled(await queue.fail('jobs', first));
        await clock.tick(1000);
        await clock.tick(1000);
        return {
          timeline,
          second: second.map(({ id: jobId, retryCount }) => ({
            id: jobId,
            retryCount,
          })),
          staleFail,
          end: await attempt(queue, 'jobs', 1),
          third: ids(await queue.fetch('jobs')),
          errors: errors.map((error) => error.message),
        };
      },
      supervised,
    );

    // failJobsByTimeout: started_on + expire_seconds < now
    // (plans.js:2372-2378).
    assert.deepStrictEqual(observed, {
      timeline: [
        {
          at: 1000,
          job: { state: 'active', retryCount: 0, startedOn: 0, heartbeatOn: 0 },
        },
        {
          at: 2000,
          job: {
            state: 'retry',
            retryCount: 0,
            startedOn: 0,
            heartbeatOn: null,
          },
        },
      ],
      second: [{ id: id(1), retryCount: 1 }],
      staleFail: { jobs: [id(1)], requested: 1, affected: 0, settled: [] },
      end: {
        state: 'failed',
        retryCount: 1,
        startedOn: 2000,
        heartbeatOn: null,
      },
      third: [],
      errors: [],
    });
  });
});
