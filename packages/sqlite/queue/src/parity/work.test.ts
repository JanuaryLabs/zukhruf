import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TestClock } from 'pg-boss';

import { ParityRun } from './backends.ts';
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

// What a call did: 'resolved', or the error class and message it rejected with.
async function outcome(call: () => Promise<unknown>) {
  try {
    await call();
    return 'resolved';
  } catch (error) {
    return error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  }
}

describe('workers', () => {
  it('validate work arguments the way pg-boss does, before the stopped check', async () => {
    // Wrongly typed values arrive the way an untyped caller sends them: as
    // parsed JSON, which the option types cannot reject at compile time.
    const invalid = {
      nullOptions: 'null',
      notAnObject: '"fast"',
      pollingTooFast: '{"pollingIntervalSeconds":0.4}',
      notifyTooFast: '{"notifyPollingIntervalSeconds":0.4}',
      notifyBelowPolling:
        '{"pollingIntervalSeconds":2,"notifyPollingIntervalSeconds":1}',
      burstWhenReadyExceeds: '{"burstWhenReadyExceeds":0}',
      burstWhenBatchFull: '{"burstWhenBatchFull":"yes"}',
      batchSizeZero: '{"batchSize":0}',
      batchSizeFraction: '{"batchSize":1.5}',
      includeMetadata: '{"includeMetadata":"yes"}',
      priority: '{"priority":"yes"}',
      localConcurrencyZero: '{"localConcurrency":0}',
      localConcurrencyInfinite: '{"localConcurrency":1e400}',
      perJobResults: '{"perJobResults":"yes"}',
      transactional: '{"transactional":"yes"}',
      minPriority: '{"minPriority":1.5}',
      priorityRange: '{"minPriority":5,"maxPriority":1}',
      bothGroupLimits: '{"groupConcurrency":1,"localGroupConcurrency":1}',
      groupConcurrency: '{"groupConcurrency":0}',
      groupTiers: '{"groupConcurrency":{"default":1,"tiers":{"a":0}}}',
      localGroupOverLocal: '{"localGroupConcurrency":3,"localConcurrency":2}',
      heartbeatRefresh: '{"heartbeatRefreshSeconds":0}',
      timeoutWithoutTransaction: '{"transactionTimeoutSeconds":5}',
      transactionalPerJob: '{"transactional":true,"perJobResults":true}',
    };

    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      const handler = async () => {};
      const results: Record<string, string> = {};
      for (const [label, options] of Object.entries(invalid)) {
        results[label] = await outcome(() =>
          queue.work('jobs', JSON.parse(options), handler),
        );
      }
      results.noHandler = await outcome(() =>
        queue.work('jobs', {}, JSON.parse('null')),
      );
      await queue.stop({ graceful: false, close: false });
      results.invalidWhenStopped = await outcome(() =>
        queue.work('jobs', JSON.parse(invalid.pollingTooFast), handler),
      );
      results.validWhenStopped = await outcome(() =>
        queue.work('jobs', {}, handler),
      );
      return results;
    });

    // node_modules/pg-boss/dist/attorney.js:306-398, 585-607, run before
    // work() checks whether the instance is stopped (manager.js:910-914).
    const rejects = (message: string) => `AssertionError: ${message}`;
    assert.deepStrictEqual(observed, {
      nullOptions: 'resolved',
      notAnObject: rejects('expected config to be an object'),
      pollingTooFast: rejects(
        'configuration assert: pollingIntervalSeconds must be at least every 500ms',
      ),
      notifyTooFast: rejects(
        'configuration assert: notifyPollingIntervalSeconds must be at least every 500ms',
      ),
      notifyBelowPolling: rejects(
        'configuration assert: notifyPollingIntervalSeconds must be at least pollingIntervalSeconds',
      ),
      burstWhenReadyExceeds: rejects(
        'configuration assert: burstWhenReadyExceeds must be an integer >= 1',
      ),
      burstWhenBatchFull: rejects(
        'configuration assert: burstWhenBatchFull must be a boolean',
      ),
      batchSizeZero: rejects('batchSize must be an integer > 0'),
      batchSizeFraction: rejects('batchSize must be an integer > 0'),
      includeMetadata: rejects('includeMetadata must be a boolean'),
      priority: rejects('priority must be a boolean'),
      localConcurrencyZero: rejects('localConcurrency must be an integer >= 1'),
      localConcurrencyInfinite: rejects(
        'localConcurrency must be an integer >= 1',
      ),
      perJobResults: rejects('perJobResults must be a boolean'),
      transactional: rejects('transactional must be a boolean'),
      minPriority: rejects('minPriority must be an integer'),
      priorityRange: rejects('minPriority must be <= maxPriority'),
      bothGroupLimits: rejects(
        'cannot specify both groupConcurrency and localGroupConcurrency - choose one',
      ),
      groupConcurrency: rejects('groupConcurrency must be an integer >= 1'),
      groupTiers: rejects(
        'groupConcurrency.tiers["a"] must be an integer >= 1',
      ),
      localGroupOverLocal: rejects(
        'localGroupConcurrency (3) cannot exceed localConcurrency (2)',
      ),
      heartbeatRefresh: rejects('heartbeatRefreshSeconds must be a number > 0'),
      timeoutWithoutTransaction: rejects(
        'transactionTimeoutSeconds requires transactional',
      ),
      transactionalPerJob: rejects(
        'transactional cannot be combined with perJobResults',
      ),
      noHandler: rejects('expected callback to be a function'),
      invalidWhenStopped: rejects(
        'configuration assert: pollingIntervalSeconds must be at least every 500ms',
      ),
      validWhenStopped: 'Error: Workers are disabled. pg-boss is stopped',
    });
  });

  it('fetch again only when their polling interval comes due', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      const ran: Record<string, string[]> = { standard: [], fast: [] };
      for (const [n, name] of ['standard', 'fast'].entries()) {
        await queue.createQueue(name);
        await queue.send(name, null, { id: id(10 * n + 1) });
      }
      // A later created_on puts each second job behind the first.
      await clock.setTime(Date.parse('2026-01-01T00:00:00.001Z'));
      for (const [n, name] of ['standard', 'fast'].entries()) {
        await queue.send(name, null, { id: id(10 * n + 2) });
      }

      await queue.work('standard', {}, async ([job]) => {
        ran.standard?.push(job?.id ?? '');
      });
      // The first fetch lands after work() resolves, as database I/O does.
      const ranWhenWorkResolved = ran.standard?.length;
      await queue.work('fast', { pollingIntervalSeconds: 1 }, async ([job]) => {
        ran.fast?.push(job?.id ?? '');
      });
      const snapshot = () => structuredClone(ran);
      await flush(clock);
      const registered = snapshot();
      await clock.tick(999);
      await flush(clock);
      const beforeASecond = snapshot();
      await clock.tick(1);
      await flush(clock);
      const afterASecond = snapshot();
      await clock.tick(1000);
      await flush(clock);
      const afterTwoSeconds = snapshot();
      return {
        ranWhenWorkResolved,
        registered,
        beforeASecond,
        afterASecond,
        afterTwoSeconds,
      };
    });

    // A worker fetches when it registers, then waits out its polling
    // interval, 2s unless set (node_modules/pg-boss/dist/worker.js:50-90,
    // attorney.js:587-589).
    assert.deepStrictEqual(observed, {
      ranWhenWorkResolved: 0,
      registered: { standard: [id(1)], fast: [id(11)] },
      beforeASecond: { standard: [id(1)], fast: [id(11)] },
      afterASecond: { standard: [id(1)], fast: [id(11), id(12)] },
      afterTwoSeconds: { standard: [id(1), id(2)], fast: [id(11), id(12)] },
    });
  });

  it('fetch again at once after a full batch only with burstWhenBatchFull and a batch above one', async () => {
    const workers = {
      burst: { batchSize: 2, burstWhenBatchFull: true },
      single: { burstWhenBatchFull: true },
      plain: { batchSize: 2 },
    };
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      const batches: Record<string, string[][]> = {};
      for (const [n, name] of Object.keys(workers).entries()) {
        await queue.createQueue(name);
        for (const job of [1, 2, 3]) {
          await clock.setTime(Date.parse(ParityRun.start) + job);
          await queue.send(name, null, { id: id(10 * n + job) });
        }
      }
      for (const [name, options] of Object.entries(workers)) {
        batches[name] = [];
        await queue.work(name, options, async (jobs) => {
          batches[name]?.push(jobs.map((job) => job.id).sort());
        });
      }
      await flush(clock);
      return batches;
    });

    // A full batch skips the wait only when burstWhenBatchFull asks and the
    // batch holds more than one job (node_modules/pg-boss/dist/manager.js:
    // 942-949).
    assert.deepStrictEqual(observed, {
      burst: [[id(1), id(2)], [id(3)]],
      single: [[id(11)]],
      plain: [[id(21), id(22)]],
    });
  });

  it('claim as the first fetch is issued, ahead of a statement issued after work() resolves', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', null, { id: id(1) });
      const held = Promise.withResolvers<void>();
      await queue.work('jobs', async () => {
        await held.promise;
      });
      try {
        return (await queue.findJobs('jobs')).map((job) => job.state);
      } finally {
        held.resolve();
      }
    });

    // PGlite runs statements in the order they arrive, so the claim lands
    // before findJobs reads even though its result is still on its way back
    // (node_modules/pg-boss/dist/manager.js:1575-1577).
    assert.deepStrictEqual(observed, ['active']);
  });

  it('drain a burst of full batches inside one tick, with no real-time wait', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      for (const n of [1, 2, 3, 4, 5, 6, 7]) {
        await clock.setTime(Date.parse(ParityRun.start) + n);
        await queue.send('jobs', null, { id: id(n) });
      }
      const batches: string[][] = [];
      await queue.work(
        'jobs',
        { batchSize: 2, burstWhenBatchFull: true },
        async (jobs) => {
          batches.push(jobs.map((job) => job.id).sort());
        },
      );
      await clock.tick(0);
      return [...batches];
    });

    // The attached clock waits for every statement the burst starts before
    // tick() returns (node_modules/pg-boss/dist/clock.js:88-117,
    // activity.js:77-93), each fetch starting as the last batch settles.
    assert.deepStrictEqual(observed, [
      [id(1), id(2)],
      [id(3), id(4)],
      [id(5), id(6)],
      [id(7)],
    ]);
  });

  it('count the time a batch took against the wait before the next fetch', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', null, { id: id(1) });
      await clock.setTime(Date.parse(ParityRun.start) + 1);
      await queue.send('jobs', null, { id: id(2) });
      const ran: string[] = [];
      const release = Promise.withResolvers<void>();
      await queue.work('jobs', {}, async ([job]) => {
        ran.push(job?.id ?? '');
        if (job?.id === id(1)) {
          await release.promise;
        }
      });
      await flush(clock);
      // The batch runs 1.5s of the 2s interval.
      await clock.tick(1500);
      release.resolve();
      await flush(clock);
      await clock.tick(499);
      await flush(clock);
      const before = [...ran];
      await clock.tick(1);
      await flush(clock);
      return { before, after: [...ran] };
    });

    // The worker waits `interval - duration` (worker.js:79-89).
    assert.deepStrictEqual(observed, {
      before: [id(1)],
      after: [id(1), id(2)],
    });
  });

  it('let a graceful stop wait for the handler in flight', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', null, { id: id(1) });
      const release = Promise.withResolvers<void>();
      let finished = false;
      await queue.work('jobs', {}, async () => {
        await release.promise;
        finished = true;
      });
      await flush(clock);
      setTimeout(release.resolve, 50);
      await queue.stop({ graceful: true, close: false });
      return { finished };
    });

    // node_modules/pg-boss/dist/index.js:260-273.
    assert.deepStrictEqual(observed, { finished: true });
  });

  it('take a handler alone as work(name, handler), with default options', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', { n: 1 }, { id: id(1) });
      const ran: unknown[] = [];
      await queue.work('jobs', async ([job]) => {
        ran.push(job?.data);
      });
      await flush(clock);
      return ran;
    });

    // attorney.js:359-362 reads a single argument as the handler.
    assert.deepStrictEqual(observed, [{ n: 1 }]);
  });

  it('wake on a send only through a notify queue, and only for a job due now', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('plain');
      await queue.createQueue('notified', { notify: true });
      await queue.createQueue('deferred', { notify: true });
      const ran: Record<string, string[]> = {
        plain: [],
        notified: [],
        deferred: [],
      };
      for (const name of Object.keys(ran)) {
        await queue.work(name, {}, async (jobs) => {
          ran[name]?.push(...jobs.map((job) => job.id));
        });
      }
      await flush(clock);
      await queue.send('plain', null, { id: id(1) });
      await queue.send('notified', null, { id: id(2) });
      await queue.send('deferred', null, { id: id(3), startAfter: 1 });
      await flush(clock);
      const atSend = structuredClone(ran);
      await clock.tick(2000);
      await flush(clock);
      const afterAPoll = structuredClone(ran);
      return { atSend, afterAPoll };
    });

    // A notify queue's send wakes its workers at once when a stored job is due
    // now (node_modules/pg-boss/dist/plans.js:2335-2350, manager.js:1137-1143);
    // other jobs wait for the poll, 30s on a notify queue (attorney.js:600).
    assert.deepStrictEqual(observed, {
      atSend: { plain: [], notified: [id(2)], deferred: [] },
      afterAPoll: { plain: [id(1)], notified: [id(2)], deferred: [] },
    });
  });

  // Each case: the work() options, how many sends follow it back to back, and
  // whether a tick settles the first fetch before them.
  for (const { label, options, sends, settleFirst } of [
    { label: 'one job a batch, two sends', options: {}, sends: 2 },
    { label: 'one job a batch, three sends', options: {}, sends: 3 },
    {
      label: 'two loops of one job, four sends',
      options: { localConcurrency: 2 },
      sends: 4,
    },
    {
      label: 'two loops of five jobs, three sends',
      options: { batchSize: 5, localConcurrency: 2 },
      sends: 3,
    },
    {
      label: 'two loops of five jobs, three sends after a settled fetch',
      options: { batchSize: 5, localConcurrency: 2 },
      sends: 3,
      settleFirst: true,
    },
    {
      label: 'one loop of five jobs, three sends after a settled fetch',
      options: { batchSize: 5 },
      sends: 3,
      settleFirst: true,
    },
  ]) {
    it(`run every job sent to a notify queue right after work() within the tick (${label})`, async () => {
      const ids = Array.from({ length: sends }, (_, index) => id(index + 1));
      const observed = await Parity.assertSame(async ({ queue, clock }) => {
        await queue.start();
        await queue.createQueue('jobs', { notify: true });
        const ran: string[] = [];
        await queue.work('jobs', options, async (jobs) => {
          ran.push(...jobs.map((job) => job.id));
        });
        if (settleFirst) {
          await clock.tick(0);
        }
        for (const job of ids) {
          await queue.send('jobs', null, { id: job });
        }
        await clock.tick(0);
        const inTick = ran.toSorted();
        await clock.tick(30000);
        return { inTick, afterBackstop: ran.toSorted() };
      });

      // Each insert raises its NOTIFY as it runs (PGlite's src/pglite.ts:
      // 980-992), and a wake during a fetch makes the loop fetch again
      // (worker.js:86, 96-100), so none waits for the 30s backstop. Which
      // batch takes which job follows PGlite's microtask depth, so only the
      // jobs that ran are compared.
      assert.deepStrictEqual(observed, { inTick: ids, afterBackstop: ids });
    });
  }

  it('leave a worker waiting out its notify poll when the sent job is not due yet', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs', { notify: true });
      const ran: string[] = [];
      await queue.work('jobs', {}, async (jobs) => {
        ran.push(...jobs.map((job) => job.id));
      });
      await flush(clock);
      // Ten seconds into the worker's 30s wait, send a job due in ten more.
      await clock.tick(10_000);
      await queue.send('jobs', null, { id: id(1), startAfter: 10 });
      await flush(clock);
      await clock.tick(20_000);
      await flush(clock);
      return ran;
    });

    // No NOTIFY for a job not due now (plans.js:2346), so the worker keeps
    // its wait and finds the job when that wait ends; a wake would have
    // restarted the 30s wait.
    assert.deepStrictEqual(observed, [id(1)]);
  });

  it('poll a notify queue every 30s, or every notifyPollingIntervalSeconds', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      const ran: Record<string, string[]> = { backstop: [], custom: [] };
      for (const name of Object.keys(ran)) {
        await queue.createQueue(name, { notify: true });
      }
      await queue.work('backstop', {}, async (jobs) => {
        ran.backstop?.push(...jobs.map((job) => job.id));
      });
      await queue.work(
        'custom',
        { notifyPollingIntervalSeconds: 10 },
        async (jobs) => {
          ran.custom?.push(...jobs.map((job) => job.id));
        },
      );
      await flush(clock);
      // Jobs due in five seconds wake no one; each waits for its queue's poll.
      await queue.send('backstop', null, { id: id(1), startAfter: 5 });
      await queue.send('custom', null, { id: id(2), startAfter: 5 });
      const at = async (ms: number) => {
        await clock.tick(ms);
        await flush(clock);
        return structuredClone(ran);
      };
      return {
        beforeTen: await at(9_999),
        atTen: await at(1),
        beforeThirty: await at(19_999),
        atThirty: await at(1),
      };
    });

    // notifyPollingIntervalSeconds defaults to max(30s, the base poll)
    // (node_modules/pg-boss/dist/attorney.js:590-602).
    assert.deepStrictEqual(observed, {
      beforeTen: { backstop: [], custom: [] },
      atTen: { backstop: [], custom: [id(2)] },
      beforeThirty: { backstop: [], custom: [id(2)] },
      atThirty: { backstop: [id(1)], custom: [id(2)] },
    });
  });

  it('wake on a send as updateQueue turns notify on or off', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('on');
      await queue.updateQueue('on', { notify: true });
      await queue.createQueue('off', { notify: true });
      await queue.updateQueue('off', { notify: false });
      const ran: Record<string, string[]> = { on: [], off: [] };
      for (const name of Object.keys(ran)) {
        await queue.work(name, {}, async (jobs) => {
          ran[name]?.push(...jobs.map((job) => job.id));
        });
      }
      await flush(clock);
      await queue.send('on', null, { id: id(1) });
      await queue.send('off', null, { id: id(2) });
      await flush(clock);
      return ran;
    });

    // updateQueue writes notify like every other queue option
    // (plans.js:1172); a caller that sets up its queues on each start turns
    // it on this way, when createQueue finds the queue already there.
    assert.deepStrictEqual(observed, { on: [id(1)], off: [] });
  });

  it('retry a failed job at the next poll, since fail wakes no worker', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs', { retryLimit: 1 });
      let attempts = 0;
      await queue.work('jobs', {}, async () => {
        attempts++;
        throw new Error('handler failed');
      });
      await flush(clock);
      await queue.send('jobs', null, { id: id(1) });
      await flush(clock);
      const afterSend = attempts;
      await clock.tick(2000);
      await flush(clock);
      const afterFirstPoll = attempts;
      await clock.tick(2000);
      await flush(clock);
      return { afterSend, afterFirstPoll, afterSecondPoll: attempts };
    });

    // Only inserts and updates NOTIFY (plans.js:2346, 3119); a failed job's
    // retry is found by the next poll.
    assert.deepStrictEqual(observed, {
      afterSend: 0,
      afterFirstPoll: 1,
      afterSecondPoll: 2,
    });
  });

  it('hand a handler the minimal job, or every column with includeMetadata', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      const seen: Record<string, unknown> = {};
      for (const [n, name] of ['plain', 'metadata'].entries()) {
        await queue.createQueue(name);
        await queue.send(name, { n }, { id: id(n + 1), singletonKey: 'k' });
        // The plain worker omits the option, so its default is what runs.
        await queue.work(
          name,
          name === 'metadata' ? { includeMetadata: true } : {},
          async ([job]) => {
            seen[name] = job && {
              keys: Object.keys(job).sort(),
              job: Observe.job(job),
            };
          },
        );
      }
      await flush(clock);
      return seen;
    });

    // JOB_COLUMNS_MIN unless includeMetadata asks for JOB_COLUMNS_ALL
    // (node_modules/pg-boss/dist/plans.js:591-620, 2028), plus the signal
    // the worker adds (manager.js:535).
    const minimal = [
      'data',
      'expireInSeconds',
      'groupId',
      'groupTier',
      'heartbeatSeconds',
      'id',
      'name',
      'retryCount',
    ];
    assert.deepStrictEqual(observed, {
      plain: {
        keys: [...minimal, 'signal'].sort(),
        job: {
          data: { n: 0 },
          expireInSeconds: 900,
          groupId: null,
          groupTier: null,
          heartbeatSeconds: null,
          id: id(1),
          name: 'plain',
          retryCount: 0,
        },
      },
      metadata: {
        keys: [
          ...minimal,
          'signal',
          'blocked',
          'blocking',
          'completedOn',
          'createdOn',
          'deadLetter',
          'deleteAfterSeconds',
          'heartbeatOn',
          'keepUntil',
          'output',
          'pendingDependencies',
          'policy',
          'priority',
          'retryBackoff',
          'retryDelay',
          'retryDelayMax',
          'retryLimit',
          'singletonKey',
          'singletonOn',
          'sourceCreatedOn',
          'sourceId',
          'sourceName',
          'sourceOutput',
          'sourceRetryCount',
          'sourceRootId',
          'startAfter',
          'startedOn',
          'state',
        ].sort(),
        job: {
          blocked: false,
          blocking: false,
          completedOn: null,
          createdOn: 0,
          data: { n: 1 },
          deadLetter: null,
          deleteAfterSeconds: 604800,
          expireInSeconds: 900,
          groupId: null,
          groupTier: null,
          heartbeatOn: 0,
          heartbeatSeconds: null,
          id: id(2),
          keepUntil: 1209600000,
          name: 'metadata',
          output: null,
          pendingDependencies: 0,
          policy: 'standard',
          priority: 0,
          retryBackoff: false,
          retryCount: 0,
          retryDelay: 0,
          retryDelayMax: null,
          retryLimit: 2,
          singletonKey: 'k',
          singletonOn: null,
          sourceCreatedOn: null,
          sourceId: null,
          sourceName: null,
          sourceOutput: null,
          sourceRetryCount: null,
          sourceRootId: null,
          startAfter: 0,
          startedOn: 0,
          state: 'active',
        },
      },
    });
  });

  it('stop every loop of one work() call by its id, or a queue by name once its handlers finish, with offWork', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      let claimed = 0;
      let finished = 0;
      const first = await queue.work(
        'jobs',
        { localConcurrency: 2 },
        async (jobs) => {
          claimed += jobs.length;
        },
      );
      await queue.work('jobs', {}, async (jobs) => {
        claimed += jobs.length;
        await new Promise((resolve) => setTimeout(resolve, 100));
        finished += jobs.length;
      });
      await flush(clock);
      // Both of the first call's loops stop: only the second call's single
      // loop takes one of the two jobs at the next poll.
      await queue.offWork('jobs', { id: first });
      await queue.send('jobs', null, { id: id(1) });
      await queue.send('jobs', null, { id: id(2) });
      await clock.tick(2000);
      const claimedAfterOnePoll = claimed;
      // Waits by default for the handler still running.
      await queue.offWork('jobs');
      return { claimedAfterOnePoll, finishedWhenOffWorkReturned: finished };
    });

    // offWork matches a work() call's id against every loop it started and
    // waits unless told not to (manager.js:1095-1125).
    assert.deepStrictEqual(observed, {
      claimedAfterOnePoll: 1,
      finishedWhenOffWorkReturned: 1,
    });
  });
});
