import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { JobAttempt } from 'pg-boss';

import type { JobQueue } from '../index.ts';
import { id } from '../testing/job-id.ts';
import { outcome } from '../testing/outcome.ts';
import { sortSettled } from '../testing/sort-settled.ts';
import { supervised } from '../testing/supervised.ts';
import { ParityRun } from './backends.ts';
import { Observe } from './observe.ts';
import { Parity } from './parity.ts';

const origin = Date.parse(ParityRun.start);

// The fields of each job of a queue that a touch or the supervisor writes,
// in id order.
async function beats(queue: JobQueue, name: string) {
  const jobs = await queue.findJobs(name);
  return jobs
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((job) => {
      const {
        id: jobId,
        state,
        retryCount,
        heartbeatOn,
        output,
      } = Observe.job(job);
      return { id: jobId, state, retryCount, heartbeatOn, output };
    });
}

// A fetch that must give exactly the jobs `ns`, sorted by id.
async function fetchJobs(queue: JobQueue, name: string, ns: number[]) {
  const fetched = await queue.fetch(name, { batchSize: ns.length });
  const sorted = fetched.toSorted((a, b) => a.id.localeCompare(b.id));
  assert.deepStrictEqual(
    sorted.map((job) => job.id),
    ns.map((n) => id(n)),
  );
  return sorted.map(({ id: jobId, retryCount }) => ({ id: jobId, retryCount }));
}

const states = [
  'created',
  'retry',
  'active',
  'completed',
  'cancelled',
  'failed',
] as const;

// One job in each state that the queue can hold, made through the queue's own
// calls. Each job was fetched at most one time, so its attempt is 0.
async function jobInEachState(queue: JobQueue, name: string, base: number) {
  await queue.createQueue(name, { retryLimit: 1, heartbeatSeconds: 10 });
  const job = (state: (typeof states)[number]): JobAttempt => ({
    id: id(base + states.indexOf(state)),
    retryCount: 0,
  });
  const jobs = {
    created: job('created'),
    retry: job('retry'),
    active: job('active'),
    completed: job('completed'),
    cancelled: job('cancelled'),
    failed: job('failed'),
  };
  const claim = async (state: (typeof states)[number], options = {}) => {
    await queue.send(name, null, { id: jobs[state].id, ...options });
    await fetchJobs(queue, name, [base + states.indexOf(state)]);
  };
  await claim('failed', { retryLimit: 0 });
  await queue.fail(name, jobs.failed, { arranged: 'failed' });
  await claim('cancelled');
  await queue.cancel(name, jobs.cancelled);
  await claim('completed');
  await queue.complete(name, jobs.completed, { arranged: 'completed' });
  // A long delay keeps the retry job out of the fetches after it.
  await claim('retry', { retryDelay: 600 });
  await queue.fail(name, jobs.retry, { arranged: 'retry' });
  await claim('active');
  await queue.send(name, null, { id: jobs.created.id });
  return jobs;
}

describe('touch()', () => {
  it('refuses a missing id, a mix of ids and jobs, a text that is not a uuid and a queue that does not exist, with the errors of pg-boss, and touches nothing', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs', { heartbeatSeconds: 10 });
      await queue.send('jobs', null, { id: id(1) });
      await fetchJobs(queue, 'jobs', [1]);
      await clock.tick(1000);
      // The arguments of each refused call, as an untyped caller sends them.
      const refused: Record<string, unknown[]> = {
        noId: ['jobs'],
        emptyId: ['jobs', ''],
        noIds: ['jobs', []],
        mixed: ['jobs', [id(1), { id: id(1), retryCount: 0 }]],
        nullJob: ['jobs', [null]],
        noRetryCount: ['jobs', { id: id(1) }],
        negative: ['jobs', { id: id(1), retryCount: -1 }],
        fractional: ['jobs', { id: id(1), retryCount: 0.5 }],
        noName: [undefined, id(1)],
        badName: ['a b', id(1)],
        notUuid: ['jobs', 'nope'],
        notUuidJob: ['jobs', { id: 'nope', retryCount: 0 }],
        // One text that is not a uuid refuses the whole call.
        notUuidInBatch: ['jobs', [id(1), 'nope']],
        missingQueue: ['missing', id(1)],
        missingQueueJob: ['missing', { id: id(1), retryCount: 0 }],
        noIdsOnMissingQueue: ['missing', []],
        notUuidOnMissingQueue: ['missing', 'nope'],
      };
      const refusals: Record<string, string> = {};
      for (const [key, args] of Object.entries(refused)) {
        refusals[key] = await outcome(() =>
          Reflect.apply(queue.touch, queue, args),
        );
      }
      const afterRefusals = await beats(queue, 'jobs');
      // The lookup takes each spelling of a uuid, and the fence is built from
      // the canonical one (plans.js:2593-2612).
      const braced = await queue.touch('jobs', {
        id: `{${id(1)}}`,
        retryCount: 0,
      });
      return {
        refusals,
        afterRefusals,
        braced,
        end: await beats(queue, 'jobs'),
      };
    });

    // mapAttemptArg (manager.js:1980-1990), then the queue (manager.js:2414),
    // then the statement.
    const requires = 'AssertionError: touch() requires an id';
    const notAMix =
      'AssertionError: touch() requires either ids or jobs with an id and an integer retryCount, not a mix';
    const checks = {
      noId: requires,
      emptyId: requires,
      noIds: requires,
      mixed: notAMix,
      nullJob: notAMix,
      noRetryCount: notAMix,
      negative: notAMix,
      fractional: notAMix,
      noIdsOnMissingQueue: requires,
    };
    for (const [key, message] of Object.entries(checks)) {
      assert.equal(observed.refusals[key], message, key);
    }
    assert.ok(
      Object.values(observed.refusals).every(
        (refusal) => refusal !== 'resolved',
      ),
    );
    const active = (heartbeatOn: number) => ({
      id: id(1),
      state: 'active',
      retryCount: 0,
      heartbeatOn,
      output: null,
    });
    assert.deepStrictEqual(observed.afterRefusals, [active(0)]);
    assert.deepStrictEqual(observed.braced, {
      jobs: [`{${id(1)}}`],
      requested: 1,
      affected: 1,
      settled: [id(1)],
    });
    assert.deepStrictEqual(observed.end, [active(1000)]);
  });

  it('keeps a job touched by its job or by its id active through each supervise pass, while the supervisor fails the jobs that nobody touched', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('beats', {
        heartbeatSeconds: 10,
        retryLimit: 1,
        retryDelay: 600,
      });
      // The queue has no heartbeat; the send gives job 4 its own.
      await queue.createQueue('plain', { retryLimit: 0 });
      for (const n of [1, 2, 3]) {
        await queue.send('beats', null, { id: id(n) });
      }
      await queue.send('plain', null, { id: id(4), heartbeatSeconds: 10 });
      const [byJob] = await fetchJobs(queue, 'beats', [1, 2, 3]);
      assert.ok(byJob, 'the batch is short');
      await fetchJobs(queue, 'plain', [4]);
      const timeline = [];
      for (const step of [5000, 5000, 1000, 4000, 5000]) {
        await clock.tick(step);
        timeline.push({
          at: clock.now() - origin,
          touches: {
            byJob: await queue.touch('beats', byJob),
            byId: await queue.touch('beats', id(2)),
          },
          beats: await beats(queue, 'beats'),
          plain: await beats(queue, 'plain'),
        });
      }
      return timeline;
    }, supervised);

    // failJobsByHeartbeat: heartbeat_on + heartbeat_seconds < now
    // (plans.js:2962-2967, 2972-2975), and a touch sets heartbeat_on to now
    // (plans.js:2993-3006).
    const touched = (n: number) => ({
      jobs: [id(n)],
      requested: 1,
      affected: 1,
      settled: [id(n)],
    });
    const active = (n: number, heartbeatOn: number) => ({
      id: id(n),
      state: 'active',
      retryCount: 0,
      heartbeatOn,
      output: null,
    });
    const lapsed = (n: number, state: string) => ({
      id: id(n),
      state,
      retryCount: 0,
      heartbeatOn: null,
      output: { value: { message: 'job heartbeat timeout' } },
    });
    const touches = { byJob: touched(1), byId: touched(2) };
    assert.deepStrictEqual(
      observed.map(({ at, touches: t, beats: b, plain }) => ({
        at,
        touches: t,
        beats: b,
        plain,
      })),
      [
        {
          at: 5000,
          touches,
          beats: [active(1, 5000), active(2, 5000), active(3, 0)],
          plain: [active(4, 0)],
        },
        {
          at: 10000,
          touches,
          beats: [active(1, 10000), active(2, 10000), active(3, 0)],
          plain: [active(4, 0)],
        },
        {
          at: 11000,
          touches,
          beats: [active(1, 11000), active(2, 11000), lapsed(3, 'retry')],
          plain: [lapsed(4, 'failed')],
        },
        {
          at: 15000,
          touches,
          beats: [active(1, 15000), active(2, 15000), lapsed(3, 'retry')],
          plain: [lapsed(4, 'failed')],
        },
        {
          at: 20000,
          touches,
          beats: [active(1, 20000), active(2, 20000), lapsed(3, 'retry')],
          plain: [lapsed(4, 'failed')],
        },
      ],
    );
  });

  it('takes one job, one id, an array of jobs and an array of ids, and gives the ids it was asked about and the ids it touched, each one time', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs', { heartbeatSeconds: 10 });
      for (const n of [1, 2, 3, 4, 5, 6, 7]) {
        await queue.send('jobs', null, { id: id(n) });
      }
      const [one, , three, four] = await fetchJobs(
        queue,
        'jobs',
        [1, 2, 3, 4, 5, 6],
      );
      assert.ok(one && three && four, 'the batch is short');
      const responses: Record<string, unknown> = {};
      const touch = async (
        key: string,
        target: Parameters<JobQueue['touch']>[1],
      ) => {
        await clock.tick(1000);
        responses[key] = sortSettled(await queue.touch('jobs', target));
      };
      await touch('oneJob', one);
      await touch('oneId', id(2));
      await touch('jobs', [three, four]);
      // Job 7 is not fetched, and job 99 does not exist.
      await touch('ids', [id(5), id(7), id(99)]);
      await touch('duplicate', [id(6), id(6)]);
      await touch('duplicateJob', [one, one]);
      return { responses, jobs: await beats(queue, 'jobs') };
    });

    // mapCommandResponse (manager.js:2007-2017).
    const touched = (...ns: number[]) => ({
      jobs: ns.map((n) => id(n)),
      requested: ns.length,
      affected: [...new Set(ns)].filter((n) => n !== 7 && n !== 99).length,
      settled: [...new Set(ns)]
        .filter((n) => n !== 7 && n !== 99)
        .map((n) => id(n)),
    });
    const active = (n: number, heartbeatOn: number) => ({
      id: id(n),
      state: 'active',
      retryCount: 0,
      heartbeatOn,
      output: null,
    });
    assert.deepStrictEqual(observed, {
      responses: {
        oneJob: touched(1),
        oneId: touched(2),
        jobs: touched(3, 4),
        ids: touched(5, 7, 99),
        duplicate: touched(6, 6),
        duplicateJob: touched(1, 1),
      },
      jobs: [
        active(1, 6000),
        active(2, 2000),
        active(3, 3000),
        active(4, 3000),
        active(5, 4000),
        active(6, 5000),
        {
          id: id(7),
          state: 'created',
          retryCount: 0,
          heartbeatOn: null,
          output: null,
        },
      ],
    });
  });

  it('touches nothing with the job of an attempt whose heartbeat lapsed, before and after the next fetch, and touches the new attempt with a plain id', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs', {
        heartbeatSeconds: 10,
        retryLimit: 1,
        retryDelay: 0,
      });
      await queue.send('jobs', null, { id: id(1) });
      const [first] = await fetchJobs(queue, 'jobs', [1]);
      assert.ok(first, 'the job was not fetched');
      await clock.tick(10000);
      await clock.tick(1000);
      const lapsed = await beats(queue, 'jobs');
      const staleOnRetry = await queue.touch('jobs', first);
      const idOnRetry = await queue.touch('jobs', id(1));
      const [second] = await fetchJobs(queue, 'jobs', [1]);
      assert.ok(second, 'the job was not fetched again');
      await clock.tick(1000);
      const staleOnActive = await queue.touch('jobs', first);
      const afterStale = await beats(queue, 'jobs');
      await clock.tick(1000);
      const plain = await queue.touch('jobs', id(1));
      const afterPlain = await beats(queue, 'jobs');
      await clock.tick(1000);
      const both = sortSettled(await queue.touch('jobs', [first, second]));
      return {
        attempts: { first, second },
        lapsed,
        staleOnRetry,
        idOnRetry,
        staleOnActive,
        afterStale,
        plain,
        afterPlain,
        both,
        end: await beats(queue, 'jobs'),
      };
    }, supervised);

    // The fence matches an active job at the fetched retryCount only
    // (plans.js:2588-2591); plain ids carry no fence (manager.js:1980-1990),
    // and touchJobs needs an active job (plans.js:2993-3006).
    const none = { jobs: [id(1)], requested: 1, affected: 0, settled: [] };
    assert.deepStrictEqual(
      {
        attempts: observed.attempts,
        lapsed: observed.lapsed.map(({ state, retryCount, heartbeatOn }) => ({
          state,
          retryCount,
          heartbeatOn,
        })),
        staleOnRetry: observed.staleOnRetry,
        idOnRetry: observed.idOnRetry,
        staleOnActive: observed.staleOnActive,
        afterStale: observed.afterStale.map(
          ({ state, retryCount, heartbeatOn }) => ({
            state,
            retryCount,
            heartbeatOn,
          }),
        ),
        plain: observed.plain,
        afterPlain: observed.afterPlain.map(({ heartbeatOn }) => heartbeatOn),
        both: observed.both,
        end: observed.end.map(({ state, retryCount, heartbeatOn }) => ({
          state,
          retryCount,
          heartbeatOn,
        })),
      },
      {
        attempts: {
          first: { id: id(1), retryCount: 0 },
          second: { id: id(1), retryCount: 1 },
        },
        lapsed: [{ state: 'retry', retryCount: 0, heartbeatOn: null }],
        staleOnRetry: none,
        idOnRetry: none,
        staleOnActive: none,
        afterStale: [{ state: 'active', retryCount: 1, heartbeatOn: 11000 }],
        plain: { jobs: [id(1)], requested: 1, affected: 1, settled: [id(1)] },
        afterPlain: [13000],
        both: {
          jobs: [id(1), id(1)],
          requested: 2,
          affected: 1,
          settled: [id(1)],
        },
        end: [{ state: 'active', retryCount: 1, heartbeatOn: 14000 }],
      },
    );
  });

  it('touches only the active job, by id and by job, and leaves the job of each other state as it is', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      const touchEachState = async (
        name: string,
        base: number,
        by: 'id' | 'job',
      ) => {
        const jobs = await jobInEachState(queue, name, base);
        const before = await beats(queue, name);
        await clock.tick(1000);
        const responses: Record<string, unknown> = {};
        for (const state of states) {
          responses[state] = await queue.touch(
            name,
            by === 'id' ? jobs[state].id : jobs[state],
          );
        }
        return { before, responses, after: await beats(queue, name) };
      };
      return {
        byId: await touchEachState('by-id', 100, 'id'),
        byJob: await touchEachState('by-job', 200, 'job'),
      };
    });

    // state = 'active' (plans.js:2993-3006).
    for (const [by, base] of [
      [observed.byId, 100],
      [observed.byJob, 200],
    ] as const) {
      assert.deepStrictEqual(
        by.responses,
        Object.fromEntries(
          states.map((state, index) => {
            const jobId = id(base + index);
            const touched = state === 'active';
            return [
              state,
              {
                jobs: [jobId],
                requested: 1,
                affected: touched ? 1 : 0,
                settled: touched ? [jobId] : [],
              },
            ];
          }),
        ),
      );
      const changed = by.after.filter(
        (row, index) =>
          JSON.stringify(row) !== JSON.stringify(by.before[index]),
      );
      assert.deepStrictEqual(
        changed.map(({ state }) => state),
        ['active'],
      );
    }
  });
});
