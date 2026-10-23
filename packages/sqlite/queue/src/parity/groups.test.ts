import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type Job, type TestClock, policies } from 'pg-boss';

import type { JobQueue } from '../index.ts';
import { Observe } from './observe.ts';
import { Parity } from './parity.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Lets everything due now finish on both backends: tick(0) waits until each
// one's statements in flight have settled, SQLite's through its attached
// Activity (node_modules/pg-boss/dist/clock.js:88-117, activity.js:77-93).
async function flush(clock: TestClock) {
  await clock.tick(0);
}

// One poll's worth of time: both backends poll every 2s by default
// (node_modules/pg-boss/dist/attorney.js:587-589).
async function poll(clock: TestClock) {
  await clock.tick(2000);
}

// A handler that records each batch, sorted, and holds every batch until
// released.
function holding(label: (job: Job<unknown>) => string = (job) => job.id) {
  const batches: string[][] = [];
  const release = Promise.withResolvers<void>();
  return {
    batches,
    release: () => release.resolve(),
    handler: async (jobs: Job<unknown>[]) => {
      batches.push(jobs.map(label).sort());
      await release.promise;
    },
  };
}

// Each job's id and state, in id order.
async function jobStates(queue: JobQueue) {
  return (await queue.findJobs('jobs'))
    .map((job) => ({ id: job.id, state: job.state }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// The fields a claim and a restore write on a job.
async function attempt(queue: JobQueue, n: number) {
  const [job] = await queue.findJobs('jobs', { id: id(n) });
  assert.ok(job, `job ${n} is missing`);
  const { state, retryCount, startedOn, heartbeatOn } = Observe.job(job);
  return { state, retryCount, startedOn, heartbeatOn };
}

describe('group concurrency', () => {
  it('claims a batch before dropping the jobs over a group limit, so a full group shrinks the batch', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      for (const [n, group] of [
        [1, 'g1'],
        [2, 'g1'],
        [3, 'g1'],
        [4, 'g2'],
      ] as const) {
        await queue.send('jobs', null, { id: id(n), group: { id: group } });
      }
      const held = holding();
      await queue.work(
        'jobs',
        { batchSize: 3, groupConcurrency: 1 },
        held.handler,
      );
      try {
        await flush(clock);
        await poll(clock);
        const whileHeld = [...held.batches];
        held.release();
        await flush(clock);
        await poll(clock);
        await poll(clock);
        return { whileHeld, batches: [...held.batches] };
      } finally {
        held.release();
      }
    });

    // The batch's LIMIT comes before the group ranking (plans.js:1967-1968,
    // 1985-1993), so g2's job waits behind g1's even with room in the batch.
    assert.deepStrictEqual(observed, {
      whileHeld: [[id(1)]],
      batches: [[id(1)], [id(2), id(4)], [id(3)]],
    });
  });

  it("claims a group's jobs by id, not by age", async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      for (const n of [3, 2, 1]) {
        await queue.send('jobs', null, { id: id(n), group: { id: 'g1' } });
      }
      const held = holding();
      await queue.work(
        'jobs',
        { batchSize: 3, groupConcurrency: 1 },
        held.handler,
      );
      try {
        await flush(clock);
        return { batches: [...held.batches], states: await jobStates(queue) };
      } finally {
        held.release();
      }
    });

    // ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY id) (plans.js:1985).
    assert.deepStrictEqual(observed, {
      batches: [[id(1)]],
      states: [
        { id: id(1), state: 'active' },
        { id: id(2), state: 'created' },
        { id: id(3), state: 'created' },
      ],
    });
  });

  it("limits each tier by its own limit against the group's active jobs of every tier", async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      const groupConcurrency = { default: 1, tiers: { gold: 2 } };
      await queue.send('jobs', null, {
        id: id(1),
        group: { id: 'g1', tier: 'gold' },
      });
      const first = holding();
      await queue.work('jobs', { groupConcurrency }, first.handler);
      const second = holding();
      try {
        await flush(clock);
        for (const [n, tier] of [
          [2, 'silver'],
          [3, 'gold'],
          [4, undefined],
          [5, 'gold'],
        ] as const) {
          await queue.send('jobs', null, {
            id: id(n),
            group: tier ? { id: 'g1', tier } : { id: 'g1' },
          });
        }
        await queue.work(
          'jobs',
          { batchSize: 5, groupConcurrency },
          second.handler,
        );
        await flush(clock);
        return {
          first: [...first.batches],
          second: [...second.batches],
          states: await jobStates(queue),
        };
      } finally {
        first.release();
        second.release();
      }
    });

    // A tier's limit, else the default (plans.js:1857-1859), against the
    // group's active count whatever their tiers (1872-1882): silver and the
    // untiered job are at their limit of 1, gold has room for one more.
    assert.deepStrictEqual(observed, {
      first: [[id(1)]],
      second: [[id(3)]],
      states: [
        { id: id(1), state: 'active' },
        { id: id(2), state: 'created' },
        { id: id(3), state: 'active' },
        { id: id(4), state: 'created' },
        { id: id(5), state: 'created' },
      ],
    });
  });

  it('fills a group up to its limit beside its active jobs, and never limits ungrouped jobs', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', null, { id: id(1), group: { id: 'g1' } });
      const first = holding();
      await queue.work('jobs', { groupConcurrency: 2 }, first.handler);
      const second = holding();
      try {
        await flush(clock);
        for (const n of [2, 3, 4]) {
          await queue.send('jobs', null, { id: id(n), group: { id: 'g1' } });
        }
        for (const n of [5, 6, 7]) {
          await queue.send('jobs', null, { id: id(n) });
        }
        await queue.work(
          'jobs',
          { batchSize: 6, groupConcurrency: 2 },
          second.handler,
        );
        await flush(clock);
        return { second: [...second.batches], states: await jobStates(queue) };
      } finally {
        first.release();
        second.release();
      }
    });

    // active_cnt + group_rn <= groupLimit; jobs without a group always
    // pass, however many (plans.js:1990-1994).
    assert.deepStrictEqual(observed, {
      second: [[id(2), id(5), id(6), id(7)]],
      states: [
        { id: id(1), state: 'active' },
        { id: id(2), state: 'active' },
        { id: id(3), state: 'created' },
        { id: id(4), state: 'created' },
        { id: id(5), state: 'active' },
        { id: id(6), state: 'active' },
        { id: id(7), state: 'active' },
      ],
    });
  });

  it("ranks a singleton queue's group after taking one job per key", async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs', { policy: policies.singleton });
      for (const [n, singletonKey] of [
        [1, 'a'],
        [2, 'a'],
        [3, 'b'],
      ] as const) {
        await queue.send('jobs', null, {
          id: id(n),
          singletonKey,
          group: { id: 'g1' },
        });
      }
      const held = holding();
      await queue.work(
        'jobs',
        { batchSize: 3, groupConcurrency: 2 },
        held.handler,
      );
      try {
        await flush(clock);
        // Which of a's jobs runs is the planner's pick on pg-boss
        // (plans.js:1973 ranks a key without an ORDER BY), so keys are read.
        const running = (await queue.findJobs('jobs'))
          .filter((job) => job.state === 'active')
          .map((job) => job.singletonKey)
          .sort();
        return {
          batchSizes: held.batches.map((batch) => batch.length),
          running,
        };
      } finally {
        held.release();
      }
    });

    // The group ranks only each key's first job (plans.js:1986-1988), so a's
    // second job takes no place in g1's limit of 2.
    assert.deepStrictEqual(observed, {
      batchSizes: [2],
      running: ['a', 'b'],
    });
  });

  // Each send is [ms after the previous send, id, key]. Every key's head is
  // a job other than the group's lowest id, so a claim that ranked the group
  // without taking heads first would pick another job.
  for (const { limit, sends, expected } of [
    {
      limit: 1,
      sends: [
        [0, 2, 'a'],
        [1, 1, 'a'],
        [0, 3, 'b'],
      ],
      expected: {
        whileHeld: [[id(2)]],
        heldStates: [
          { id: id(1), state: 'created' },
          { id: id(2), state: 'active' },
          { id: id(3), state: 'created' },
        ],
        batches: [[id(2)], [id(1)], [id(3)]],
      },
    },
    {
      limit: 2,
      sends: [
        [0, 1, 'a'],
        [0, 2, 'a'],
        [0, 3, 'b'],
        [0, 4, 'c'],
      ],
      expected: {
        whileHeld: [[id(1), id(3)]],
        heldStates: [
          { id: id(1), state: 'active' },
          { id: id(2), state: 'created' },
          { id: id(3), state: 'active' },
          { id: id(4), state: 'created' },
        ],
        batches: [
          [id(1), id(3)],
          [id(2), id(4)],
        ],
      },
    },
  ] as const) {
    it(`holds back a key_strict_fifo head while its group is full (groupConcurrency ${limit})`, async () => {
      const observed = await Parity.assertSame(async ({ queue, clock }) => {
        await queue.start();
        await queue.createQueue('jobs', { policy: policies.key_strict_fifo });
        for (const [after, n, singletonKey] of sends) {
          await clock.tick(after);
          await queue.send('jobs', null, {
            id: id(n),
            singletonKey,
            group: { id: 'g1' },
          });
        }
        const held = holding();
        await queue.work(
          'jobs',
          { batchSize: sends.length, groupConcurrency: limit },
          held.handler,
        );
        try {
          await flush(clock);
          await poll(clock);
          const whileHeld = [...held.batches];
          const heldStates = await jobStates(queue);
          held.release();
          await flush(clock);
          await poll(clock);
          await poll(clock);
          return { whileHeld, heldStates, batches: [...held.batches] };
        } finally {
          held.release();
        }
      });

      // Each key offers only its head (plans.js:1900-1917), and the group
      // limit ranks the heads after the LIMIT (1985-1993): a head past the
      // limit waits, and a full group keeps every key's head out of the
      // claim until a job of the group ends.
      assert.deepStrictEqual(observed, expected);
    });
  }

  it('looks a tier up by its exact name, quotes and placeholders included', async () => {
    const tiers = ["a'b", '$1', 'x"y', '{"a":1}', 'untiered'];
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      for (const [index, tier] of tiers.entries()) {
        for (const n of [2 * index + 1, 2 * index + 2]) {
          await queue.send('jobs', null, {
            id: id(n),
            group: { id: `g${index}`, tier },
          });
        }
      }
      const held = holding();
      const groupConcurrency = {
        default: 1,
        tiers: { "a'b": 2, $1: 2, 'x"y': 2, '{"a":1}': 2 },
      };
      await queue.work(
        'jobs',
        { batchSize: 2 * tiers.length, groupConcurrency },
        held.handler,
      );
      try {
        await flush(clock);
        return { batches: [...held.batches] };
      } finally {
        held.release();
      }
    });

    // tiers ->> group_tier (plans.js:1857-1859): each named tier allows both
    // of its group's jobs; a tier the config does not name falls back to the
    // default of 1.
    assert.deepStrictEqual(observed, {
      batches: [
        [id(1), id(2), id(3), id(4), id(5), id(6), id(7), id(8), id(9)],
      ],
    });
  });
});

describe('local group concurrency', () => {
  it('puts back the jobs over a group limit before the handler runs, leaving their attempt unspent', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      for (const [n, group] of [
        [1, 'g1'],
        [2, 'g1'],
        [3, 'g2'],
      ] as const) {
        await queue.send('jobs', null, { id: id(n), group: { id: group } });
      }
      const held = holding();
      await queue.work(
        'jobs',
        { batchSize: 2, localConcurrency: 2, localGroupConcurrency: 1 },
        held.handler,
      );
      try {
        await flush(clock);
        const restored = await attempt(queue, 2);
        const firstBatches = [...held.batches];
        await poll(clock);
        const whileHeld = await attempt(queue, 2);
        held.release();
        await flush(clock);
        await poll(clock);
        return {
          firstBatches,
          restored,
          whileHeld,
          batches: [...held.batches],
          released: await attempt(queue, 2),
        };
      } finally {
        held.release();
      }
    });

    // The first worker claims [1, 2] and restores 2 (manager.js:972-980,
    // plans.js:2201-2209) while the second claims [3]; 2 runs once 1 ends.
    const unstarted = {
      state: 'created',
      retryCount: 0,
      startedOn: null,
      heartbeatOn: null,
    };
    assert.deepStrictEqual(observed, {
      firstBatches: [[id(3)], [id(1)]],
      restored: unstarted,
      whileHeld: unstarted,
      batches: [[id(3)], [id(1)], [id(2)]],
      released: {
        state: 'completed',
        retryCount: 0,
        startedOn: 2000,
        heartbeatOn: 2000,
      },
    });
  });

  it('lets a sibling worker claim a restored job in the same poll, once the restoring batch has failed', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs', { retryLimit: 3, retryDelay: 1 });
      for (const n of [1, 2]) {
        await queue.send('jobs', null, { id: id(n), group: { id: 'g1' } });
      }
      const ran: string[] = [];
      await queue.work(
        'jobs',
        { batchSize: 2, localConcurrency: 2, localGroupConcurrency: 1 },
        async (jobs) => {
          ran.push(...jobs.map((job) => `${job.id}@${job.retryCount}`));
          throw new Error('boom');
        },
      );
      const states = async () =>
        (await queue.findJobs('jobs'))
          .map((job) => `${job.id}:${job.state}@${job.retryCount}`)
          .sort();
      await flush(clock);
      const timeline = [{ ran: [...ran], states: await states() }];
      for (let polls = 0; polls < 3; polls++) {
        await poll(clock);
        timeline.push({ ran: [...ran], states: await states() });
      }
      return timeline;
    });

    // At each poll the clock fires one worker's timer and waits for its
    // fetch, restore and failed batch before the sibling's (clock.js:88-117),
    // so the sibling finds g1 free and claims the restored job 2.
    assert.deepStrictEqual(observed, [
      {
        ran: [`${id(1)}@0`],
        states: [`${id(1)}:retry@0`, `${id(2)}:created@0`],
      },
      {
        ran: [`${id(1)}@0`, `${id(1)}@1`, `${id(2)}@0`],
        states: [`${id(1)}:retry@1`, `${id(2)}:retry@0`],
      },
      {
        ran: [
          `${id(1)}@0`,
          `${id(1)}@1`,
          `${id(2)}@0`,
          `${id(1)}@2`,
          `${id(2)}@1`,
        ],
        states: [`${id(1)}:retry@2`, `${id(2)}:retry@1`],
      },
      {
        ran: [
          `${id(1)}@0`,
          `${id(1)}@1`,
          `${id(2)}@0`,
          `${id(1)}@2`,
          `${id(2)}@1`,
          `${id(1)}@3`,
          `${id(2)}@2`,
        ],
        states: [`${id(1)}:failed@3`, `${id(2)}:retry@2`],
      },
    ]);
  });

  it('puts a retrying job back as created at the attempt its claim counted', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs', { retryLimit: 3 });
      for (const n of [1, 2]) {
        await queue.send('jobs', null, { id: id(n), group: { id: 'g1' } });
      }
      const failing = await queue.work('jobs', { batchSize: 2 }, async () => {
        throw new Error('first attempt');
      });
      await flush(clock);
      await queue.offWork('jobs', { id: failing, wait: true });
      const retrying = [await attempt(queue, 1), await attempt(queue, 2)];
      const held = holding((job) => `${job.id}@${job.retryCount}`);
      await queue.work(
        'jobs',
        { batchSize: 2, localGroupConcurrency: 1 },
        held.handler,
      );
      try {
        await flush(clock);
        const claimed = [await attempt(queue, 1), await attempt(queue, 2)];
        held.release();
        await flush(clock);
        await poll(clock);
        return { retrying, claimed, batches: [...held.batches] };
      } finally {
        held.release();
      }
    });

    // The claim counts an attempt of a started job (plans.js:2023); the
    // restore clears started_on and keeps retry_count, so the next claim
    // counts none (plans.js:2201-2209).
    assert.deepStrictEqual(observed, {
      retrying: [
        { state: 'retry', retryCount: 0, startedOn: 0, heartbeatOn: null },
        { state: 'retry', retryCount: 0, startedOn: 0, heartbeatOn: null },
      ],
      claimed: [
        { state: 'active', retryCount: 1, startedOn: 0, heartbeatOn: 0 },
        { state: 'created', retryCount: 1, startedOn: null, heartbeatOn: null },
      ],
      batches: [[`${id(1)}@1`], [`${id(2)}@1`]],
    });
  });

  it('skips the groups this process holds at their limit, reading them when each fetch starts', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      for (const n of [1, 2]) {
        await queue.send('jobs', null, { id: id(n), group: { id: 'g1' } });
      }
      await queue.fail('jobs', id(2));
      const held = holding();
      await queue.work(
        'jobs',
        { localConcurrency: 2, localGroupConcurrency: 1 },
        held.handler,
      );
      try {
        await flush(clock);
        const atStart = {
          batches: [...held.batches],
          second: await attempt(queue, 2),
        };
        // Ahead of the restored job 2, so the poll's one-job claim reaches it.
        await queue.send('jobs', null, {
          id: id(3),
          priority: 1,
          group: { id: 'g1' },
        });
        await queue.fail('jobs', id(3));
        await poll(clock);
        const whileHeld = await attempt(queue, 3);
        held.release();
        await flush(clock);
        await poll(clock);
        return {
          atStart,
          whileHeld,
          batches: [...held.batches],
          second: await attempt(queue, 2),
          third: await attempt(queue, 3),
        };
      } finally {
        held.release();
      }
    });

    // Both workers' first fetches read the held groups before either claim
    // lands (manager.js:951-955), so the second claims job 2 and restores it;
    // once job 1 holds g1, a fetch skips g1 (plans.js:1942) and job 3 stays
    // in retry until job 1 ends.
    assert.deepStrictEqual(observed, {
      atStart: {
        batches: [[id(1)]],
        second: {
          state: 'created',
          retryCount: 0,
          startedOn: null,
          heartbeatOn: null,
        },
      },
      whileHeld: {
        state: 'retry',
        retryCount: 0,
        startedOn: null,
        heartbeatOn: null,
      },
      batches: [[id(1)], [id(3)], [id(2)]],
      second: {
        state: 'completed',
        retryCount: 0,
        startedOn: 4000,
        heartbeatOn: 4000,
      },
      third: {
        state: 'completed',
        retryCount: 0,
        startedOn: 2000,
        heartbeatOn: 2000,
      },
    });
  });

  it("skips a group only once it is full for every tier, and limits each job by its tier's limit", async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', null, {
        id: id(1),
        group: { id: 'g1', tier: 'gold' },
      });
      const held = holding();
      await queue.work(
        'jobs',
        {
          localConcurrency: 2,
          localGroupConcurrency: { default: 1, tiers: { gold: 2 } },
        },
        held.handler,
      );
      try {
        await flush(clock);
        await queue.send('jobs', null, {
          id: id(2),
          group: { id: 'g1', tier: 'silver' },
        });
        await queue.fail('jobs', id(2));
        await poll(clock);
        const silver = await attempt(queue, 2);
        await queue.send('jobs', null, {
          id: id(3),
          priority: 1,
          group: { id: 'g1', tier: 'gold' },
        });
        await poll(clock);
        return {
          silver,
          batches: [...held.batches],
          states: await jobStates(queue),
        };
      } finally {
        held.release();
      }
    });

    // With one gold job running, g1 is under its largest limit (2), so the
    // idle worker fetches from it (manager.js:235-256, 454-462): silver's
    // limit of 1 restores job 2, gold's 2 runs job 3 (manager.js:226-234).
    assert.deepStrictEqual(observed, {
      silver: {
        state: 'created',
        retryCount: 0,
        startedOn: null,
        heartbeatOn: null,
      },
      batches: [[id(1)], [id(3)]],
      states: [
        { id: id(1), state: 'active' },
        { id: id(2), state: 'created' },
        { id: id(3), state: 'active' },
      ],
    });
  });

  it('runs ungrouped jobs past the limit, and holds back a job whose tier names an inherited property', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', null, {
        id: id(1),
        group: { id: 'g1', tier: 'constructor' },
      });
      await queue.fail('jobs', id(1));
      for (const n of [2, 3]) {
        await queue.send('jobs', null, { id: id(n) });
      }
      const held = holding();
      await queue.work(
        'jobs',
        {
          batchSize: 3,
          localGroupConcurrency: { default: 1, tiers: { gold: 1 } },
        },
        held.handler,
      );
      try {
        await flush(clock);
        return {
          batches: [...held.batches],
          inherited: await attempt(queue, 1),
        };
      } finally {
        held.release();
      }
    });

    // `groupTier in config.tiers` finds Object.prototype.constructor, a
    // function no count is below (manager.js:230-232), so job 1 is put back
    // on every claim; a job without a group bypasses the limit (476-479).
    assert.deepStrictEqual(observed, {
      batches: [[id(2), id(3)]],
      inherited: {
        state: 'created',
        retryCount: 0,
        startedOn: null,
        heartbeatOn: null,
      },
    });
  });

  it("keeps a queue's group counts while another work() call still runs on it", async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      const idle = await queue.work(
        'jobs',
        { localGroupConcurrency: 1 },
        async () => {},
      );
      const held = holding();
      await queue.work(
        'jobs',
        { localConcurrency: 2, localGroupConcurrency: 1 },
        held.handler,
      );
      try {
        await flush(clock);
        await queue.offWork('jobs', { id: idle, wait: true });
        for (const n of [1, 2]) {
          await queue.send('jobs', null, { id: id(n), group: { id: 'g1' } });
        }
        await poll(clock);
        return { batches: [...held.batches], states: await jobStates(queue) };
      } finally {
        held.release();
      }
    });

    // Tracking goes only with the queue's last live worker (manager.js:
    // 463-471), so g1 still holds one job at a time.
    assert.deepStrictEqual(observed, {
      batches: [[id(1)]],
      states: [
        { id: id(1), state: 'active' },
        { id: id(2), state: 'created' },
      ],
    });
  });

  for (const wait of [true, false]) {
    it(`forgets a queue's group counts once no live worker is left, even while a stopping one still runs (offWork wait: ${wait})`, async () => {
      const observed = await Parity.assertSame(async ({ queue, clock }) => {
        await queue.start();
        await queue.createQueue('jobs');
        await queue.send('jobs', null, { id: id(1), group: { id: 'g1' } });
        const first = holding();
        const stopping = await queue.work(
          'jobs',
          { localGroupConcurrency: 1 },
          first.handler,
        );
        const idle = await queue.work(
          'jobs',
          { localGroupConcurrency: 1 },
          async () => {},
        );
        const later = holding();
        try {
          await flush(clock);
          await queue.offWork('jobs', { id: stopping, wait: false });
          await queue.offWork('jobs', { id: idle, wait });
          await flush(clock);
          await queue.send('jobs', null, { id: id(2), group: { id: 'g1' } });
          await queue.work('jobs', { localGroupConcurrency: 1 }, later.handler);
          await flush(clock);
          return {
            first: [...first.batches],
            later: [...later.batches],
            states: await jobStates(queue),
          };
        } finally {
          first.release();
          later.release();
        }
      });

      // A stopping worker is not live (manager.js:465), so the idle worker's
      // offWork clears g1's count while job 1 still runs (1117-1124), and job 2
      // joins it.
      assert.deepStrictEqual(observed, {
        first: [[id(1)]],
        later: [[id(2)]],
        states: [
          { id: id(1), state: 'active' },
          { id: id(2), state: 'active' },
        ],
      });
    });
  }

  it('limits a fetch that lands while stop() closes the listener, before the tracking is cleared', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      for (const n of [1, 2]) {
        await queue.send('jobs', null, { id: id(n), group: { id: 'g1' } });
      }
      const held = holding();
      await queue.work(
        'jobs',
        { batchSize: 2, localGroupConcurrency: 1 },
        held.handler,
      );
      try {
        await queue.stop({ graceful: false, close: false });
        await flush(clock);
        return { batches: [...held.batches], states: await jobStates(queue) };
      } finally {
        held.release();
      }
    });

    // The first fetch lands while stop() closes the listener (index.js:228),
    // ahead of the workers' stop that clears the tracking (manager.js:
    // 866-879): job 2 is restored, and the shutdown fails job 1 alone.
    assert.deepStrictEqual(observed, {
      batches: [[id(1)]],
      states: [
        { id: id(1), state: 'retry' },
        { id: id(2), state: 'created' },
      ],
    });
  });
});
