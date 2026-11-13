import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type CompleteOptions,
  type JobAttempt,
  type SendOptions,
  policies,
} from 'pg-boss';

import type { JobQueue } from '../index.ts';
import { id } from '../testing/job-id.ts';
import { outcome } from '../testing/outcome.ts';
import { ParityRun, type RunOptions } from './backends.ts';
import { Observe } from './observe.ts';
import { Parity } from './parity.ts';

const origin = Date.parse(ParityRun.start);

// Every supervisor timer at its 1 s minimum, so each second's tick runs a
// supervise pass that monitors and maintains every queue.
const supervised = {
  supervise: true,
  superviseIntervalSeconds: 1,
  monitorIntervalSeconds: 1,
  maintenanceIntervalSeconds: 1,
  queueCacheIntervalSeconds: 1,
} satisfies RunOptions;

// A settle's result with `settled` sorted: pg-boss aggregates the ids it
// touched in no specified order (plans.js:2413-2415).
const sortSettled = <T extends { settled?: string[] }>(response: T) => ({
  ...response,
  settled: response.settled?.toSorted(),
});

// A complete with arguments that the types refuse.
const untyped = (queue: JobQueue, ...args: unknown[]) =>
  Reflect.apply(queue.complete, queue, args);

// The fields a settle writes on each job of a queue, in id order.
async function settles(queue: JobQueue, name: string) {
  const jobs = await queue.findJobs(name);
  return jobs
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((job) => {
      const { id: jobId, state, retryCount, output } = Observe.job(job);
      return { id: jobId, state, retryCount, output };
    });
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
  await queue.createQueue(name, { retryLimit: 1 });
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
    const fetched = await queue.fetch(name);
    assert.deepStrictEqual(
      fetched.map((job) => job.id),
      [jobs[state].id],
    );
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

// complete() on the job of each state, then what the queue holds.
async function completeEachState(
  queue: JobQueue,
  name: string,
  base: number,
  by: 'id' | 'job',
  options?: CompleteOptions,
) {
  const jobs = await jobInEachState(queue, name, base);
  const before = await settles(queue, name);
  const responses: Record<string, unknown> = {};
  for (const state of states) {
    const target = by === 'id' ? jobs[state].id : jobs[state];
    responses[state] = await queue.complete(
      name,
      target,
      { completed: state },
      ...(options ? [options] : []),
    );
  }
  return { before, responses, after: await settles(queue, name) };
}

// What completeEachState gives when complete() settled only `settled`.
function expectedStates(base: number, settled: (typeof states)[number][]) {
  const arranged = (state: (typeof states)[number]) =>
    ['created', 'active', 'cancelled'].includes(state)
      ? null
      : { arranged: state };
  const row = (state: (typeof states)[number], completed: boolean) => ({
    id: id(base + states.indexOf(state)),
    state: completed ? 'completed' : state,
    retryCount: 0,
    output: completed ? { completed: state } : arranged(state),
  });
  return {
    before: states.map((state) => row(state, false)),
    responses: Object.fromEntries(
      states.map((state) => {
        const jobId = id(base + states.indexOf(state));
        const touched = settled.includes(state);
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
    after: states.map((state) => row(state, settled.includes(state))),
  };
}

// { ...options, singletonKey }: pg-boss reads an undefined key as no key,
// which its types cannot hold under exactOptionalPropertyTypes.
const keyed = (options: SendOptions, singletonKey: string | undefined) => {
  Reflect.set(options, 'singletonKey', singletonKey);
  return options;
};

describe('complete()', () => {
  it('refuses a missing id, a mix of ids and jobs, a text that is not a uuid and a queue that does not exist, with the errors of pg-boss', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', null, { id: id(1) });
      await queue.fetch('jobs');
      const refusals = {
        noId: await outcome(() => untyped(queue, 'jobs')),
        emptyId: await outcome(() => queue.complete('jobs', '')),
        noIds: await outcome(() => queue.complete('jobs', [])),
        // A mix arrives the way an untyped caller sends it.
        mixed: await outcome(() =>
          untyped(queue, 'jobs', [id(1), { id: id(1), retryCount: 0 }]),
        ),
        nullJob: await outcome(() => untyped(queue, 'jobs', [null])),
        noRetryCount: await outcome(() =>
          untyped(queue, 'jobs', { id: id(1) }),
        ),
        negative: await outcome(() =>
          queue.complete('jobs', { id: id(1), retryCount: -1 }),
        ),
        fractional: await outcome(() =>
          queue.complete('jobs', { id: id(1), retryCount: 0.5 }),
        ),
        noName: await outcome(() => untyped(queue, undefined, id(1))),
        badName: await outcome(() => queue.complete('a b', id(1))),
        notUuid: await outcome(() => queue.complete('jobs', 'nope')),
        notUuidJob: await outcome(() =>
          queue.complete('jobs', { id: 'nope', retryCount: 0 }),
        ),
        // One text that is not a uuid refuses the whole call.
        notUuidInBatch: await outcome(() =>
          queue.complete('jobs', [id(1), 'nope']),
        ),
        missingQueue: await outcome(() => queue.complete('missing', id(1))),
        missingQueueJob: await outcome(() =>
          queue.complete('missing', { id: id(1), retryCount: 0 }),
        ),
        noIdsOnMissingQueue: await outcome(() => queue.complete('missing', [])),
        notUuidOnMissingQueue: await outcome(() =>
          queue.complete('missing', 'nope'),
        ),
      };
      const afterRefusals = await settles(queue, 'jobs');
      // The lookup takes each spelling of a uuid, and the fence is built from
      // the canonical one (plans.js:2056-2075).
      const braced = await queue.complete('jobs', {
        id: `{${id(1)}}`,
        retryCount: 0,
      });
      return {
        refusals,
        afterRefusals,
        braced,
        end: await settles(queue, 'jobs'),
      };
    });

    // mapAttemptArg (manager.js:1596-1606), then the queue (manager.js:1640),
    // then the statement.
    const requires = 'AssertionError: complete() requires an id';
    const notAMix =
      'AssertionError: complete() requires either ids or jobs with an id and an integer retryCount, not a mix';
    assert.deepStrictEqual(
      {
        noId: observed.refusals.noId,
        emptyId: observed.refusals.emptyId,
        noIds: observed.refusals.noIds,
        mixed: observed.refusals.mixed,
        nullJob: observed.refusals.nullJob,
        noRetryCount: observed.refusals.noRetryCount,
        negative: observed.refusals.negative,
        fractional: observed.refusals.fractional,
        noIdsOnMissingQueue: observed.refusals.noIdsOnMissingQueue,
      },
      {
        noId: requires,
        emptyId: requires,
        noIds: requires,
        mixed: notAMix,
        nullJob: notAMix,
        noRetryCount: notAMix,
        negative: notAMix,
        fractional: notAMix,
        noIdsOnMissingQueue: requires,
      },
    );
    for (const refusal of Object.values(observed.refusals)) {
      assert.notEqual(refusal, 'resolved');
    }
    assert.deepStrictEqual(observed.afterRefusals, [
      { id: id(1), state: 'active', retryCount: 0, output: null },
    ]);
    assert.deepStrictEqual(observed.braced, {
      jobs: [`{${id(1)}}`],
      requested: 1,
      affected: 1,
      settled: [id(1)],
    });
    assert.deepStrictEqual(observed.end, [
      { id: id(1), state: 'completed', retryCount: 0, output: null },
    ]);
  });

  it('settles nothing with the job of an attempt that a fail and a second fetch ended, and completes the new attempt with a plain id', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs', { retryLimit: 2 });
      const lapse = async (n: number) => {
        await queue.send('jobs', null, { id: id(n) });
        const [first] = await queue.fetch('jobs');
        assert.ok(first, 'the job was not fetched');
        await queue.fail('jobs', id(n), { lapsed: n });
        const [second] = await queue.fetch('jobs');
        assert.ok(second, 'the job was not fetched again');
        return {
          first: { id: first.id, retryCount: first.retryCount },
          second: { id: second.id, retryCount: second.retryCount },
        };
      };
      const one = await lapse(1);
      const stale = await queue.complete('jobs', one.first, { by: 'stale' });
      const afterStale = await settles(queue, 'jobs');
      const plain = await queue.complete('jobs', id(1), { by: 'id' });
      const afterPlain = await settles(queue, 'jobs');
      const late = await queue.complete('jobs', one.second, { by: 'late' });
      const two = await lapse(2);
      const both = sortSettled(
        await queue.complete('jobs', [two.first, two.second], { by: 'both' }),
      );
      return {
        attempts: { one, two },
        stale,
        afterStale,
        plain,
        afterPlain,
        late,
        both,
        end: await settles(queue, 'jobs'),
      };
    });

    // The fence matches an active job at the fetched retryCount only
    // (plans.js:2051-2054); plain ids carry no fence (manager.js:1596-1606).
    const none = { jobs: [id(1)], requested: 1, affected: 0, settled: [] };
    assert.deepStrictEqual(observed, {
      attempts: {
        one: {
          first: { id: id(1), retryCount: 0 },
          second: { id: id(1), retryCount: 1 },
        },
        two: {
          first: { id: id(2), retryCount: 0 },
          second: { id: id(2), retryCount: 1 },
        },
      },
      stale: none,
      afterStale: [
        { id: id(1), state: 'active', retryCount: 1, output: { lapsed: 1 } },
      ],
      plain: { jobs: [id(1)], requested: 1, affected: 1, settled: [id(1)] },
      afterPlain: [
        { id: id(1), state: 'completed', retryCount: 1, output: { by: 'id' } },
      ],
      late: none,
      both: {
        jobs: [id(2), id(2)],
        requested: 2,
        affected: 1,
        settled: [id(2)],
      },
      end: [
        { id: id(1), state: 'completed', retryCount: 1, output: { by: 'id' } },
        {
          id: id(2),
          state: 'completed',
          retryCount: 1,
          output: { by: 'both' },
        },
      ],
    });
  });

  it('settles nothing with the job of an attempt that the supervisor expired, before and after the next fetch', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        await queue.createQueue('jobs', { retryLimit: 1 });
        await queue.send('jobs', null, { id: id(1), expireInSeconds: 1 });
        const [first] = await queue.fetch('jobs');
        assert.ok(first, 'the job was not fetched');
        await clock.tick(1000);
        await clock.tick(1000);
        const expired = await settles(queue, 'jobs');
        const staleOnRetry = await queue.complete('jobs', first, { by: 1 });
        const [second] = await queue.fetch('jobs');
        assert.ok(second, 'the job was not fetched again');
        const staleOnActive = await queue.complete('jobs', first, { by: 2 });
        const afterStale = await settles(queue, 'jobs');
        const current = await queue.complete('jobs', second, { by: 3 });
        await clock.tick(1000);
        await clock.tick(1000);
        return {
          expired,
          staleOnRetry,
          staleOnActive,
          afterStale,
          current,
          end: await settles(queue, 'jobs'),
          errors: errors.map((error) => error.message),
        };
      },
      supervised,
    );

    // failJobsByTimeout (plans.js:2372-2378), then the fence.
    const none = { jobs: [id(1)], requested: 1, affected: 0, settled: [] };
    assert.deepStrictEqual(
      {
        expired: observed.expired.map(({ state }) => state),
        staleOnRetry: observed.staleOnRetry,
        staleOnActive: observed.staleOnActive,
        afterStale: observed.afterStale.map(({ state, retryCount }) => ({
          state,
          retryCount,
        })),
        current: observed.current,
        end: observed.end,
        errors: observed.errors,
      },
      {
        expired: ['retry'],
        staleOnRetry: none,
        staleOnActive: none,
        afterStale: [{ state: 'active', retryCount: 1 }],
        current: { jobs: [id(1)], requested: 1, affected: 1, settled: [id(1)] },
        end: [
          { id: id(1), state: 'completed', retryCount: 1, output: { by: 3 } },
        ],
        errors: [],
      },
    );
  });

  it('completes only the active job when it has no includeQueued, by id and by job, and leaves the job of each other state as it is', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      return {
        byId: await completeEachState(queue, 'by-id', 100, 'id'),
        byJob: await completeEachState(queue, 'by-job', 200, 'job'),
        byIdFalse: await completeEachState(queue, 'by-id-false', 300, 'id', {
          includeQueued: false,
        }),
      };
    });

    // state = 'active' (plans.js:2082-2095).
    assert.deepStrictEqual(observed, {
      byId: expectedStates(100, ['active']),
      byJob: expectedStates(200, ['active']),
      byIdFalse: expectedStates(300, ['active']),
    });
  });

  it('completes the created, retry and active jobs by id with includeQueued, never a completed, cancelled or failed job, and with a job only the active one', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      const includeQueued = { includeQueued: true };
      return {
        byId: await completeEachState(queue, 'by-id', 100, 'id', includeQueued),
        byJob: await completeEachState(
          queue,
          'by-job',
          200,
          'job',
          includeQueued,
        ),
      };
    });

    // state < 'completed' (plans.js:2082-2095); the fence still needs an
    // active job (plans.js:2051-2054).
    assert.deepStrictEqual(observed, {
      byId: expectedStates(100, ['created', 'retry', 'active']),
      byJob: expectedStates(200, ['active']),
    });
  });

  it('takes one job, one id, an array of jobs and an array of ids, and gives the ids it was asked about and the ids it settled, each one time', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      for (const n of [1, 2, 3, 4, 5, 6, 7]) {
        await queue.send('jobs', null, { id: id(n) });
      }
      const fetched = await queue.fetch('jobs', { batchSize: 6 });
      const [one, , three, four] = fetched.sort((a, b) =>
        a.id.localeCompare(b.id),
      );
      assert.ok(one && three && four, 'the batch is short');
      const responses = {
        oneJob: await queue.complete('jobs', one, { by: 'oneJob' }),
        oneId: await queue.complete('jobs', id(2), { by: 'oneId' }),
        jobs: sortSettled(
          await queue.complete('jobs', [three, four], { by: 'jobs' }),
        ),
        // Job 7 is not fetched, and job 99 does not exist.
        ids: sortSettled(
          await queue.complete('jobs', [id(5), id(7), id(99)], { by: 'ids' }),
        ),
        duplicate: await queue.complete('jobs', [id(6), id(6)], {
          by: 'duplicate',
        }),
        again: await queue.complete('jobs', [id(1), id(2)], { by: 'again' }),
      };
      return { responses, jobs: await settles(queue, 'jobs') };
    });

    // mapCommandResponse (manager.js:1623-1633).
    const completed = (n: number, by: string) => ({
      id: id(n),
      state: 'completed',
      retryCount: 0,
      output: { by },
    });
    assert.deepStrictEqual(observed, {
      responses: {
        oneJob: { jobs: [id(1)], requested: 1, affected: 1, settled: [id(1)] },
        oneId: { jobs: [id(2)], requested: 1, affected: 1, settled: [id(2)] },
        jobs: {
          jobs: [id(3), id(4)],
          requested: 2,
          affected: 2,
          settled: [id(3), id(4)],
        },
        ids: {
          jobs: [id(5), id(7), id(99)],
          requested: 3,
          affected: 1,
          settled: [id(5)],
        },
        duplicate: {
          jobs: [id(6), id(6)],
          requested: 2,
          affected: 1,
          settled: [id(6)],
        },
        again: { jobs: [id(1), id(2)], requested: 2, affected: 0, settled: [] },
      },
      jobs: [
        completed(1, 'oneJob'),
        completed(2, 'oneId'),
        completed(3, 'jobs'),
        completed(4, 'jobs'),
        completed(5, 'ids'),
        completed(6, 'duplicate'),
        { id: id(7), state: 'created', retryCount: 0, output: null },
      ],
    });
  });

  it('stores an object as it is, a scalar or an array as { value }, and nothing for no data, and writes the time of the clock', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      const data: Record<string, unknown[]> = {
        object: [{ a: 1, nested: { b: [1, 'two'] } }],
        text: ['done'],
        number: [7],
        zero: [0],
        boolean: [false],
        array: [[1, 2]],
        null: [null],
        undefined: [undefined],
        function: [() => 1],
        absent: [],
      };
      const sent = Object.keys(data);
      for (const [index] of sent.entries()) {
        await clock.setTime(origin + index);
        await queue.send('jobs', null, { id: id(index + 1) });
      }
      const fetched = await queue.fetch('jobs', { batchSize: sent.length });
      await clock.setTime(origin + 5000);
      const results: Record<string, unknown> = {};
      for (const [index, kind] of sent.entries()) {
        const response = await untyped(
          queue,
          'jobs',
          id(index + 1),
          ...(data[kind] ?? []),
        );
        const [found] = await queue.findJobs('jobs', { id: id(index + 1) });
        assert.ok(found, `job ${kind} is missing`);
        const { state, output, completedOn, startedOn } = Observe.job(found);
        results[kind] = { response, state, output, completedOn, startedOn };
      }
      return { fetched: fetched.length, results };
    });

    // mapCompletionDataArg (manager.js:1614-1622).
    const outputs = Object.fromEntries(
      Object.entries(observed.results).map(([kind, result]) => [
        kind,
        Reflect.get(Object(result), 'output'),
      ]),
    );
    assert.deepStrictEqual(outputs, {
      object: { a: 1, nested: { b: [1, 'two'] } },
      text: { value: 'done' },
      number: { value: 7 },
      zero: { value: 0 },
      boolean: { value: false },
      array: { value: [1, 2] },
      null: null,
      undefined: null,
      function: null,
      absent: null,
    });
    assert.deepStrictEqual(observed.results['object'], {
      response: { jobs: [id(1)], requested: 1, affected: 1, settled: [id(1)] },
      state: 'completed',
      output: { a: 1, nested: { b: [1, 'two'] } },
      completedOn: 5000,
      startedOn: 9,
    });
  });

  it('frees the slot of a completed job on each policy queue, so the next fetch takes the job that waited behind it', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      const results: Record<string, Record<string, unknown>> = {};
      let n = 0;
      for (const policy of Object.values(policies)) {
        await queue.createQueue(policy, { policy });
        const send = async (singletonKey: string | undefined) => {
          await clock.setTime(origin + ++n);
          const options = keyed({ id: id(n) }, singletonKey);
          let sent: string | null = 'not sent';
          const refusal = await outcome(async () => {
            sent = await queue.send(policy, null, options);
          });
          return refusal === 'resolved'
            ? sent === null
              ? 'refused'
              : 'sent'
            : refusal;
        };
        // The key and the state of each job, sorted. Which job of a key a
        // batch takes is not specified: pg-boss ranks them with no ORDER BY
        // (plans.js:1971-1975).
        const held = async () =>
          (await queue.findJobs(policy))
            .map((job) => `${job.singletonKey} ${job.state}`)
            .sort();
        const sentFirst = await Array.fromAsync(
          ['a', 'a', 'b', undefined, undefined],
          send,
        );
        const first = await queue.fetch(policy, { batchSize: 10 });
        const sentSecond = await Array.fromAsync(['a', 'b', undefined], send);
        const whileActive = await queue.fetch(policy, { batchSize: 10 });
        const beforeComplete = await held();
        const completed = await queue.complete(policy, first, { done: true });
        const afterComplete = await queue.fetch(policy, { batchSize: 10 });
        const sentAfter = await Array.fromAsync(['a', 'b'], send);
        const afterSend = await queue.fetch(policy, { batchSize: 10 });
        results[policy] = {
          sent: [...sentFirst, ...sentSecond],
          first: first.length,
          whileActive: whileActive.length,
          beforeComplete,
          completed: {
            requested: Reflect.get(completed, 'requested'),
            affected: Reflect.get(completed, 'affected'),
          },
          afterComplete: afterComplete.length,
          sentAfter,
          afterSend: afterSend.length,
          end: await held(),
        };
      }
      return results;
    });

    // A completed job is outside the indexes and the ranks that hold a slot
    // (plans.js:1842, 1907-1939, 1971-1975).
    const fetches = Object.fromEntries(
      Object.entries(observed).map(([policy, result]) => [
        policy,
        {
          first: result['first'],
          whileActive: result['whileActive'],
          affected: Reflect.get(Object(result['completed']), 'affected'),
          afterComplete: result['afterComplete'],
        },
      ]),
    );
    assert.deepStrictEqual(fetches, {
      standard: { first: 5, whileActive: 3, affected: 5, afterComplete: 0 },
      short: { first: 3, whileActive: 3, affected: 3, afterComplete: 0 },
      singleton: { first: 3, whileActive: 0, affected: 3, afterComplete: 3 },
      stately: { first: 3, whileActive: 0, affected: 3, afterComplete: 3 },
      // An exclusive queue refuses a send while its key has a job
      // (plans.js:922), so no job waited.
      exclusive: { first: 3, whileActive: 0, affected: 3, afterComplete: 0 },
      key_strict_fifo: {
        first: 2,
        whileActive: 0,
        affected: 2,
        afterComplete: 2,
      },
    });
    assert.deepStrictEqual(
      {
        sentAfter: observed['exclusive']?.['sentAfter'],
        afterSend: observed['exclusive']?.['afterSend'],
      },
      { sentAfter: ['sent', 'sent'], afterSend: 2 },
    );
  });
});
