import assert from 'node:assert/strict';
import { describe } from 'node:test';

import { it } from '@zukhruf/parameterized-test';

import type { JobQueue } from '../index.ts';
import { id } from '../testing/job-id.ts';
import { outcome } from '../testing/outcome.ts';
import { supervised } from '../testing/supervised.ts';
import { ParityRun } from './backends.ts';
import { Parity } from './parity.ts';

const origin = Date.parse(ParityRun.start);

const since = (value: unknown) =>
  value instanceof Date
    ? value.getTime() - origin
    : `not a Date: ${String(value)}`;

// The queues a read gives, with their dates in ms since the clock's start.
async function list(
  queue: JobQueue,
  ...args: Parameters<JobQueue['getQueues']>
) {
  const queues = await queue.getQueues(...args);
  return queues.map((found) => ({
    ...found,
    createdOn: since(found.createdOn),
    updatedOn: since(found.updatedOn),
    deltaOn: found.deltaOn === null ? null : since(found.deltaOn),
  }));
}

// The names a read gives, in its order, from arguments as an untyped caller
// sends them.
async function names(queue: JobQueue, ...args: unknown[]) {
  const queues: unknown = await Reflect.apply(queue.getQueues, queue, args);
  assert.ok(Array.isArray(queues));
  return queues.map((found: { name: string }) => found.name);
}

// A fetch that must give exactly the job `n`.
async function fetchJob(queue: JobQueue, name: string, n: number) {
  const fetched = await queue.fetch(name);
  assert.deepStrictEqual(
    fetched.map((job) => job.id),
    [id(n)],
  );
}

// What getQueues reads with persistQueueStats off: no monitor pass writes the
// throughput window, the histograms or the oldest ready job (12.39.0:
// plans.js:4538), so they keep the columns' defaults (plans.js:369-376), and
// toBins hands an unwritten histogram out as null (manager.js:136-138). No
// job here waits on a flow parent.
const uncounted = {
  blockedCount: 0,
  createdDelta: 0,
  completedDelta: 0,
  failedDelta: 0,
  deltaSeconds: null,
  deltaOn: null,
  waitBins: null,
  runBins: null,
  readyOldestSeconds: null,
};

const limitMessage =
  'AssertionError: getQueues: limit must be an integer between 1 and 100000';
const afterMessage =
  'AssertionError: getQueues: after must be a non-empty string';
const characters =
  'AssertionError: Name can only contain alphanumeric characters, underscores, hyphens, periods, or forward slashes';

describe('getQueues()', () => {
  // index.js:488-492 checks the limit, then after (attorney.js:582-597),
  // then manager.js:2653-2677 each name (attorney.js:605-609).
  void it.each(
    [
      {
        case: 'a limit of 0',
        args: [undefined, { limit: 0 }],
        refusal: limitMessage,
      },
      {
        case: 'a fractional limit',
        args: [undefined, { limit: 1.5 }],
        refusal: limitMessage,
      },
      {
        case: 'a limit in text',
        args: [undefined, { limit: '5' }],
        refusal: limitMessage,
      },
      {
        case: 'a null limit',
        args: [undefined, { limit: null }],
        refusal: limitMessage,
      },
      {
        case: 'a limit above 100000',
        args: [undefined, { limit: 100_001 }],
        refusal: limitMessage,
      },
      {
        case: 'an empty after',
        args: [undefined, { after: '' }],
        refusal: afterMessage,
      },
      {
        case: 'an after that is no text',
        args: [undefined, { after: 5 }],
        refusal: afterMessage,
      },
      {
        case: 'a null after',
        args: [undefined, { after: null }],
        refusal: afterMessage,
      },
      {
        case: 'one name that is not a queue name',
        args: ['a b'],
        refusal: characters,
      },
      {
        case: 'one empty name',
        args: [''],
        refusal: 'AssertionError: Name is required',
      },
      {
        case: 'an empty name among the names',
        args: [['jobs', '']],
        refusal: 'AssertionError: Name is required',
      },
      {
        case: 'a null among the names',
        args: [['jobs', null]],
        refusal: 'AssertionError: Name is required',
      },
      {
        case: 'a number among the names',
        args: [['jobs', 5]],
        refusal: 'AssertionError: Name must be a string',
      },
      {
        case: 'a name that is not a queue name among the names',
        args: [['jobs', 'a b']],
        refusal: characters,
      },
      {
        case: 'a bad limit before a bad after',
        args: [undefined, { limit: 0, after: '' }],
        refusal: limitMessage,
      },
      {
        case: 'a bad limit before a bad name',
        args: [['a b'], { limit: 0 }],
        refusal: limitMessage,
      },
      {
        case: 'a bad after before a bad name',
        args: [['a b'], { after: '' }],
        refusal: afterMessage,
      },
    ],
    (row) =>
      it(`refuses ${row.case} with the error of pg-boss`, async () => {
        const observed = await Parity.assertSame(async ({ queue }) => {
          await queue.start();
          await queue.createQueue('jobs');
          return outcome(() => Reflect.apply(queue.getQueues, queue, row.args));
        });

        assert.equal(observed, row.refusal);
      }),
  );

  it('reads the queues that the names give, each one time in name order, skips a name with no queue, and reads every queue for no names', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      // w.r1- sorts between w.r1 and w.r10 and is in no list of names, so
      // a page of names after w.r1 must skip it.
      for (const name of ['w.r2', 'other', 'w.r10', 'w.r1', 'w.r1-']) {
        await queue.createQueue(name);
      }
      return {
        missing: await names(queue, ['missing']),
        mixed: await names(queue, ['w.r2', 'missing', 'w.r1', 'w.r2']),
        one: await names(queue, 'w.r10'),
        noNames: await names(queue),
        emptyNames: await names(queue, []),
        nullNames: await names(queue, null),
        numberNames: await names(queue, 123),
        nullOptions: await names(queue, undefined, null),
        largestLimit: await names(queue, undefined, { limit: 100_000 }),
        namesAndPage: await names(queue, ['w.r2', 'w.r10', 'w.r1', 'other'], {
          after: 'w.r1',
          limit: 1,
        }),
      };
    });

    // q.name = ANY($1) only for a non-empty array, and ORDER BY q.name
    // (plans.js:1615-1668); manager.js:2654 takes neither null nor a number
    // as names.
    const every = ['other', 'w.r1', 'w.r1-', 'w.r10', 'w.r2'];
    assert.deepStrictEqual(observed, {
      missing: [],
      mixed: ['w.r1', 'w.r2'],
      one: ['w.r10'],
      noNames: every,
      emptyNames: every,
      nullNames: every,
      numberNames: every,
      nullOptions: every,
      largestLimit: every,
      namesAndPage: ['w.r10'],
    });
  });

  it('reads no queue before the first is made, and no longer reads a deleted queue', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      const before = await list(queue);
      await queue.createQueue('kept');
      await queue.createQueue('deleted');
      await queue.deleteQueue('deleted');
      return {
        before,
        after: await names(queue),
        byName: await names(queue, ['deleted']),
      };
    });

    assert.deepStrictEqual(observed, {
      before: [],
      after: ['kept'],
      byName: [],
    });
  });

  it('gives every field of a queue made with the defaults and of a queue made with every option, its own table included', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('plain');
      await queue.createQueue('dead');
      await clock.tick(1000);
      await queue.createQueue('tuned', {
        policy: 'singleton',
        partition: true,
        deadLetter: 'dead',
        retryLimit: 3,
        retryDelay: 5,
        retryBackoff: true,
        retryDelayMax: 60,
        expireInSeconds: 30,
        retentionSeconds: 100,
        deleteAfterSeconds: 50,
        heartbeatSeconds: 10,
        notify: true,
        warningQueueSize: 7,
      });
      return list(queue, ['plain', 'tuned']);
    });

    // The SELECT of plans.js:1615-1668 over the row that create_queue writes
    // (plans.js:1041-1100): a partitioned queue names its own table.
    const plain = {
      name: 'plain',
      policy: 'standard',
      retryLimit: 2,
      retryDelay: 0,
      retryBackoff: false,
      retryDelayMax: null,
      expireInSeconds: 900,
      retentionSeconds: 1_209_600,
      deleteAfterSeconds: 604_800,
      partition: false,
      heartbeatSeconds: null,
      notify: false,
      deadLetter: null,
      deferredCount: 0,
      warningQueueSize: 0,
      queuedCount: 0,
      readyCount: 0,
      activeCount: 0,
      failedCount: 0,
      totalCount: 0,
      ...uncounted,
      singletonsActive: null,
      table: 'job_common',
      createdOn: 0,
      updatedOn: 0,
    };
    assert.deepStrictEqual(observed, [
      plain,
      {
        ...plain,
        name: 'tuned',
        policy: 'singleton',
        retryLimit: 3,
        retryDelay: 5,
        retryBackoff: true,
        retryDelayMax: 60,
        expireInSeconds: 30,
        retentionSeconds: 100,
        deleteAfterSeconds: 50,
        partition: true,
        heartbeatSeconds: 10,
        notify: true,
        deadLetter: 'dead',
        warningQueueSize: 7,
        table: 'j5e86c74ef9e27bb70f691bb0485e4cace45e52d35229505ad915fa2f',
        createdOn: 1000,
        updatedOn: 1000,
      },
    ]);
  });

  it('gives the counts that the monitor keeps and the uncounted throughput fields, and an update of a queue but not its second create', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.createQueue('single', { policy: 'singleton' });
      await queue.createQueue('unkeyed', { policy: 'singleton' });
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
      await queue.send('single', null, { id: id(8), singletonKey: 'k' });
      await fetchJob(queue, 'single', 8);
      await queue.send('unkeyed', null, { id: id(9) });
      await fetchJob(queue, 'unkeyed', 9);
      const uncountedYet = await list(queue);
      await clock.tick(1000);
      const counted = await list(queue);
      await queue.updateQueue('jobs', { retryLimit: 5 });
      await clock.tick(1000);
      await queue.createQueue('jobs', { retryLimit: 1 });
      return { uncountedYet, counted, updated: await list(queue, ['jobs']) };
    }, supervised);

    const fields = (found: (typeof observed.counted)[number]) => ({
      name: found.name,
      deferredCount: found.deferredCount,
      queuedCount: found.queuedCount,
      readyCount: found.readyCount,
      activeCount: found.activeCount,
      failedCount: found.failedCount,
      totalCount: found.totalCount,
      singletonsActive: found.singletonsActive,
      blockedCount: found.blockedCount,
      createdDelta: found.createdDelta,
      completedDelta: found.completedDelta,
      failedDelta: found.failedDelta,
      deltaSeconds: found.deltaSeconds,
      deltaOn: found.deltaOn,
      waitBins: found.waitBins,
      runBins: found.runBins,
      readyOldestSeconds: found.readyOldestSeconds,
    });
    const none = {
      deferredCount: 0,
      queuedCount: 0,
      readyCount: 0,
      activeCount: 0,
      failedCount: 0,
      totalCount: 0,
      singletonsActive: null,
      ...uncounted,
    };
    // The queue row holds what the last monitor pass counted (plans.js:
    // 4586-4600), nothing before the first.
    assert.deepStrictEqual(observed.uncountedYet.map(fields), [
      { name: 'jobs', ...none },
      { name: 'single', ...none },
      { name: 'unkeyed', ...none },
    ]);
    assert.deepStrictEqual(observed.counted.map(fields), [
      {
        name: 'jobs',
        ...none,
        deferredCount: 2,
        queuedCount: 3,
        readyCount: 1,
        activeCount: 1,
        failedCount: 1,
        // The maintenance pass counted the completed and cancelled jobs too
        // (setRetainedCount, plans.js:3932).
        totalCount: 7,
      },
      {
        name: 'single',
        ...none,
        activeCount: 1,
        totalCount: 1,
        singletonsActive: ['k'],
      },
      {
        name: 'unkeyed',
        ...none,
        activeCount: 1,
        totalCount: 1,
        // An active singleton job with no key holds the key null.
        singletonsActive: [null],
      },
    ]);
    // updateQueue stamps updated_on (plans.js:1584-1609), and a create of a
    // queue that exists does nothing (ON CONFLICT DO NOTHING, plans.js:1091).
    assert.deepStrictEqual(
      observed.updated.map(({ retryLimit, createdOn, updatedOn }) => ({
        retryLimit,
        createdOn,
        updatedOn,
      })),
      [{ retryLimit: 5, createdOn: 0, updatedOn: 1000 }],
    );
  });

  it('orders the queues by the bytes of their names, cuts each page at the limit, and goes on strictly after any text', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      for (const name of [
        'w.r2',
        'b',
        'a_b',
        'A',
        'w.r10',
        'a/b',
        '1',
        'a.b',
        'C',
        'a-b',
        'w.r1',
        'a',
      ]) {
        await queue.createQueue(name);
      }
      const pages: string[][] = [];
      let after: string | undefined;
      for (;;) {
        const page = await names(
          queue,
          undefined,
          after === undefined ? { limit: 5 } : { limit: 5, after },
        );
        pages.push(page);
        after = page.at(-1);
        if (page.length < 5) {
          break;
        }
      }
      return {
        all: await names(queue),
        pages,
        afterText: await names(queue, undefined, { after: 'a-' }),
        revisions: await names(queue, undefined, { after: 'w.r' }),
        pastTheLast: await names(queue, undefined, { after: 'z' }),
      };
    });

    // ORDER BY q.name, q.name > after, LIMIT (plans.js:1615-1668), in the C
    // collation of the oracle's database.
    assert.deepStrictEqual(observed, {
      all: [
        '1',
        'A',
        'C',
        'a',
        'a-b',
        'a.b',
        'a/b',
        'a_b',
        'b',
        'w.r1',
        'w.r10',
        'w.r2',
      ],
      pages: [
        ['1', 'A', 'C', 'a', 'a-b'],
        ['a.b', 'a/b', 'a_b', 'b', 'w.r1'],
        ['w.r10', 'w.r2'],
      ],
      afterText: ['a-b', 'a.b', 'a/b', 'a_b', 'b', 'w.r1', 'w.r10', 'w.r2'],
      revisions: ['w.r1', 'w.r10', 'w.r2'],
      pastTheLast: [],
    });
  });

  it('gives at most 1000 queues when no limit is given', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      for (let n = 0; n <= 1000; n++) {
        await queue.createQueue(`q${String(n).padStart(4, '0')}`);
      }
      const first = await names(queue);
      return {
        count: first.length,
        last: first.at(-1),
        rest: await names(queue, undefined, { after: first.at(-1) }),
      };
    });

    // LIST_LIMIT_DEFAULT (attorney.js:578-585).
    assert.deepStrictEqual(observed, {
      count: 1000,
      last: 'q0999',
      rest: ['q1000'],
    });
  });

  it('reads the queue that the timekeeper makes for its sends', async () => {
    const observed = await Parity.assertSame(
      async ({ queue }) => {
        await queue.start();
        return list(queue);
      },
      { schedule: true },
    );

    assert.deepStrictEqual(
      observed.map(({ name }) => name),
      ['__pgboss__send-it'],
    );
  });
});
