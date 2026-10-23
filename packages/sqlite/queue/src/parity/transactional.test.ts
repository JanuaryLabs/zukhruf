import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Job, TestClock, WorkOptions } from 'pg-boss';

import type { JobQueue } from '../index.ts';
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

// What a call did: 'resolved', or what it rejected with. An AssertionError
// keeps the fields node:assert derives from how it was raised, so a refusal
// thrown another way than pg-boss's assert(value, message) differs.
async function outcome(call: () => Promise<unknown>) {
  try {
    await call();
    return 'resolved';
  } catch (error) {
    if (error instanceof assert.AssertionError) {
      const { name, message, code, actual, expected, operator } = error;
      return {
        name,
        message,
        code,
        actual,
        expected,
        operator,
        generatedMessage: error.generatedMessage,
      };
    }
    return error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  }
}

// A handler that records each batch, sorted, and holds every batch until
// released.
function holding() {
  const batches: string[][] = [];
  const release = Promise.withResolvers<void>();
  return {
    batches,
    release: () => release.resolve(),
    handler: async (jobs: Job<unknown>[]) => {
      batches.push(jobs.map((job) => job.id).sort());
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

// node_modules/pg-boss/dist/manager.js:919-920, raised for the harness's
// fromPglite adapter, which implements no beginTransaction
// (adapters/pglite.js:16-155), and by SQLite for every transactional worker.
const refused = {
  name: 'AssertionError',
  message:
    'transactional workers require a database connection pg-boss can open a transaction on: the built-in pool, or a db adapter implementing beginTransaction',
  code: 'ERR_ASSERTION',
  actual: false,
  expected: true,
  operator: '==',
  generatedMessage: false,
};

describe('transactional workers', () => {
  it('are refused after the argument and stopped checks, registering nothing, while transactional: false runs', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      const refusedRan: string[] = [];
      const refusedHandler = async (jobs: Job<unknown>[]) => {
        refusedRan.push(...jobs.map((job) => job.id));
      };
      const beforeStart = await outcome(() =>
        queue.work('jobs', { transactional: true }, refusedHandler),
      );
      await queue.start();
      await queue.createQueue('jobs');
      const cases: Record<string, WorkOptions> = {
        plain: { transactional: true },
        timeout: { transactional: true, transactionTimeoutSeconds: 5 },
        noTimeout: { transactional: true, transactionTimeoutSeconds: 0 },
        negativeTimeout: { transactional: true, transactionTimeoutSeconds: -1 },
        pollingTooFast: { transactional: true, pollingIntervalSeconds: 0.4 },
        localGroupOverLocal: {
          transactional: true,
          localGroupConcurrency: 3,
          localConcurrency: 2,
        },
        perJobResults: { transactional: true, perJobResults: true },
      };
      const started: Record<string, unknown> = {};
      for (const [label, options] of Object.entries(cases)) {
        started[label] = await outcome(() =>
          queue.work('jobs', options, refusedHandler),
        );
      }

      await queue.send('jobs', null, { id: id(1) });
      await poll(clock);
      const afterRefusals = {
        refusedRan: [...refusedRan],
        states: await jobStates(queue),
      };

      const argumentCounts: number[] = [];
      await queue.work(
        'jobs',
        { transactional: false },
        async (...args: unknown[]) => {
          argumentCounts.push(args.length);
        },
      );
      await flush(clock);
      const nonTransactional = {
        argumentCounts,
        states: await jobStates(queue),
      };

      await queue.stop({ graceful: false, close: false });
      const whenStopped = await outcome(() =>
        queue.work('jobs', { transactional: true }, refusedHandler),
      );
      return {
        beforeStart,
        started,
        afterRefusals,
        nonTransactional,
        whenStopped,
        refusedRan,
      };
    });

    // work() runs checkWorkArgs (attorney.js:357-398), then the stopped check
    // (manager.js:912-914), then the capability assert (919-920), before it
    // stores a local group limit or spawns a worker (924-1003). The bound is
    // only validated (attorney.js:388-398). Without transactional the handler
    // gets the jobs alone (manager.js:603-605).
    const checkWorkArgs = (message: string) => ({ ...refused, message });
    assert.deepStrictEqual(observed, {
      beforeStart: refused,
      started: {
        plain: refused,
        timeout: refused,
        noTimeout: refused,
        negativeTimeout: checkWorkArgs(
          'transactionTimeoutSeconds must be an integer >= 0',
        ),
        pollingTooFast: checkWorkArgs(
          'configuration assert: pollingIntervalSeconds must be at least every 500ms',
        ),
        localGroupOverLocal: checkWorkArgs(
          'localGroupConcurrency (3) cannot exceed localConcurrency (2)',
        ),
        perJobResults: checkWorkArgs(
          'transactional cannot be combined with perJobResults',
        ),
      },
      afterRefusals: {
        refusedRan: [],
        states: [{ id: id(1), state: 'created' }],
      },
      nonTransactional: {
        argumentCounts: [1],
        states: [{ id: id(1), state: 'completed' }],
      },
      whenStopped: 'Error: Workers are disabled. pg-boss is stopped',
      refusedRan: [],
    });
  });

  it("leave an earlier worker's local group limit as it was", async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      const held = holding();
      await queue.work(
        'jobs',
        { localConcurrency: 2, localGroupConcurrency: 2 },
        held.handler,
      );
      try {
        const refusal = await outcome(() =>
          queue.work(
            'jobs',
            { transactional: true, localGroupConcurrency: 1 },
            async () => {},
          ),
        );
        for (const n of [1, 2]) {
          await queue.send('jobs', null, { id: id(n), group: { id: 'g1' } });
        }
        await poll(clock);
        return {
          refusal,
          batches: [...held.batches],
          states: await jobStates(queue),
        };
      } finally {
        held.release();
      }
    });

    // pg-boss stores a queue's local group limit only after the capability
    // assert passes (manager.js:919-925, 454-460), so g1 keeps its limit of
    // 2: both workers' polls claim one g1 job each and neither is restored
    // (manager.js:970-983).
    assert.deepStrictEqual(observed, {
      refusal: refused,
      batches: [[id(1)], [id(2)]],
      states: [
        { id: id(1), state: 'active' },
        { id: id(2), state: 'active' },
      ],
    });
  });

  it('read work options from the copy checkWorkArgs makes, so inherited ones are ignored', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      for (const n of [1, 2]) {
        await queue.send('jobs', null, { id: id(n) });
      }
      const batches: string[][] = [];
      const registered = await outcome(() =>
        queue.work(
          'jobs',
          Object.create({ transactional: true, batchSize: 2 }),
          async (jobs) => {
            batches.push(jobs.map((job) => job.id).sort());
          },
        ),
      );
      await flush(clock);
      return { registered, batches, states: await jobStates(queue) };
    });

    // checkWorkArgs spreads the options into a copy (attorney.js:370), which
    // keeps own properties only, and work() reads that copy
    // (manager.js:911-915): the worker is neither transactional nor batched.
    assert.deepStrictEqual(observed, {
      registered: 'resolved',
      batches: [[id(1)]],
      states: [
        { id: id(1), state: 'completed' },
        { id: id(2), state: 'created' },
      ],
    });
  });
});
