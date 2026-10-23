import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { TestClock } from 'pg-boss';

import type { FoundJob } from '../index.ts';
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

// An output with each serialized error's stack replaced by whether it was
// there, since stacks differ by backend and line.
function withoutStacks(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  const isError = 'name' in value && 'message' in value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) =>
      isError && key === 'stack'
        ? ['hasStack', typeof item === 'string']
        : [key, withoutStacks(item)],
    ),
  );
}

// A queue's jobs by id, each as the fields a settle writes.
async function settledJobs(
  queue: ParityRun['queue'],
  name: string,
): Promise<Record<string, unknown>[]> {
  const jobs: FoundJob<unknown>[] = await queue.findJobs(name);
  return jobs
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((job) => {
      const {
        id: jobId,
        state,
        startAfter,
        completedOn,
        output,
      } = Observe.job(job);
      return {
        id: jobId,
        state,
        startAfter,
        completedOn,
        output: withoutStacks(output),
      };
    });
}

// A dead letter queue's copies by the job each came from, without their
// random ids.
async function copies(queue: ParityRun['queue'], name: string) {
  const jobs: FoundJob<unknown>[] = await queue.findJobs(name);
  return jobs
    .map((job) => {
      const { sourceId, sourceOutput, sourceRetryCount, state, startAfter } =
        Observe.job(job);
      return { sourceId, sourceOutput, sourceRetryCount, state, startAfter };
    })
    .sort((a, b) => String(a.sourceId).localeCompare(String(b.sourceId)));
}

const noDisposition = {
  name: 'Error',
  message: 'no disposition returned by handler',
  hasStack: true,
};

describe('per-job results', () => {
  it('settle each job of a batch by the disposition its handler returned', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        await queue.createQueue('dlq');
        // Retries are not due before the scenario reads the jobs.
        await queue.createQueue('jobs', {
          retryLimit: 1,
          retryDelay: 60,
          deadLetter: 'dlq',
        });
        await queue.createQueue('single');
        for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
          await queue.send('jobs', null, { id: id(n) });
        }
        await queue.send('single', null, { id: id(20) });
        const release = Promise.withResolvers<void>();
        await queue.work(
          'jobs',
          { batchSize: 12, perJobResults: true },
          async () => {
            await release.promise;
            return [
              { id: id(1), status: 'completed', output: { a: 1 } },
              { id: id(2), status: 'failed', output: { why: 'x' } },
              { id: id(3), status: 'deadletter', output: { dl: 1 } },
              { id: id(5), status: 'failed' },
              { id: id(5), status: 'completed', output: 'text' },
              { id: id(6), status: 'done' },
              { id: `{${id(7)}}`, status: 'completed' },
              { id: id(8), status: 'completed' },
              { id: id(1), status: 'bogus' },
              null,
              'text',
              { id: id(99), status: 'completed' },
              { id: id(9), status: 'completed' },
              { id: id(10), status: 'failed', output: { late: 1 } },
              { id: id(11), status: 'deadletter', output: { late: 1 } },
              Object.assign(() => {}, {
                id: id(12),
                status: 'completed',
                output: { fn: 1 },
              }),
            ];
          },
        );
        await queue.work('single', { perJobResults: true }, async ([job]) => [
          { id: job?.id, status: 'completed', output: { a: 1 } },
        ]);
        await flush(clock);
        await clock.tick(5000);
        await queue.cancel('jobs', id(9));
        await queue.fail('jobs', [id(10), id(11)], { external: 1 });
        release.resolve();
        await flush(clock);
        return {
          jobs: await settledJobs(queue, 'jobs'),
          single: await settledJobs(queue, 'single'),
          copies: await copies(queue, 'dlq'),
          errors: errors.map((error) => error.message),
        };
      },
    );

    // #settlePerJob (node_modules/pg-boss/dist/manager.js:355-405): falsy
    // entries, entries naming no job of the batch by its exact id, or carrying
    // another status are ignored, the last valid entry per job wins, a job
    // without one fails with "no disposition returned by handler", and each
    // job keeps its own output at any batch size. Every settle is fenced to an
    // active job at the claimed attempt (plans.js:2134-2151, 2646-2672), so a
    // job cancelled or failed while its handler ran keeps that outcome.
    const settled = (n: number, state: string, output: unknown) => ({
      id: id(n),
      state,
      startAfter: state === 'retry' || state === 'failed' ? 65_000 : 0,
      completedOn: state === 'retry' ? null : 5000,
      output,
    });
    assert.deepStrictEqual(observed, {
      jobs: [
        settled(1, 'completed', { a: 1 }),
        settled(2, 'retry', { why: 'x' }),
        settled(3, 'failed', { dl: 1 }),
        settled(4, 'retry', noDisposition),
        settled(5, 'completed', { value: 'text' }),
        settled(6, 'retry', noDisposition),
        settled(7, 'retry', noDisposition),
        settled(8, 'completed', null),
        settled(9, 'cancelled', null),
        settled(10, 'retry', { external: 1 }),
        settled(11, 'retry', { external: 1 }),
        settled(12, 'completed', { fn: 1 }),
      ],
      single: [
        {
          id: id(20),
          state: 'completed',
          startAfter: 0,
          completedOn: 0,
          output: { a: 1 },
        },
      ],
      copies: [
        {
          sourceId: id(3),
          sourceOutput: { dl: 1 },
          sourceRetryCount: 0,
          state: 'created',
          startAfter: 5000,
        },
      ],
      errors: [],
    });
  });

  it('dead-letter a job at once, moving its start_after as a retry would', async () => {
    const queues = {
      retrying: { retryLimit: 1, retryDelay: 60, deadLetter: 'dlq' },
      spent: { retryLimit: 0, retryDelay: 60, deadLetter: 'dlq' },
      backoff: {
        retryLimit: 2,
        retryBackoff: true,
        retryDelay: 4,
        deadLetter: 'dlq',
      },
      noDeadLetter: { retryLimit: 1, retryDelay: 60 },
    };
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('dlq');
      const release = Promise.withResolvers<void>();
      for (const [n, [name, options]] of Object.entries(queues).entries()) {
        await queue.createQueue(name, options);
        await queue.send(name, null, { id: id(n + 1) });
        await queue.work(name, { perJobResults: true }, async ([job]) => {
          await release.promise;
          return [{ id: job?.id, status: 'deadletter', output: { name } }];
        });
      }
      await flush(clock);
      await clock.tick(5000);
      release.resolve();
      await flush(clock);
      const jobs: Record<string, Record<string, unknown> | undefined> = {};
      for (const name of Object.keys(queues)) {
        const [job] = await settledJobs(queue, name);
        jobs[name] = job;
      }
      // Jitter makes a backoff delay random, so it is compared by range; the
      // open lower bound excludes the 9000 a plain retry_delay would give.
      const startAfter = jobs.backoff?.startAfter;
      jobs.backoff = {
        ...jobs.backoff,
        startAfter:
          typeof startAfter === 'number' &&
          startAfter > 9000 &&
          startAfter < 13_000,
      };
      return { jobs, copies: await copies(queue, 'dlq') };
    });

    // failJobsBody's forceTerminal (plans.js:2431-2439) fails the job and
    // stamps completed_on whatever retries remain, but start_after keeps its
    // retry CASE (2494-2503): now + retry_delay, or the jittered backoff, unless
    // the job's attempts are spent. The failed job is then copied into its dead
    // letter queue (2615-2643).
    const failed = (n: number, startAfter: unknown, output: unknown) => ({
      id: id(n),
      state: 'failed',
      startAfter,
      completedOn: 5000,
      output,
    });
    assert.deepStrictEqual(observed, {
      jobs: {
        retrying: failed(1, 65_000, { name: 'retrying' }),
        spent: failed(2, 0, { name: 'spent' }),
        backoff: failed(3, true, { name: 'backoff' }),
        noDeadLetter: failed(4, 65_000, { name: 'noDeadLetter' }),
      },
      copies: [1, 2, 3].map((n) => ({
        sourceId: id(n),
        sourceOutput: { name: Object.keys(queues)[n - 1] },
        sourceRetryCount: 0,
        state: 'created',
        startAfter: 5000,
      })),
    });
  });

  it('fail the whole batch when the handler resolves anything but an array', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('object', { retryLimit: 1, retryDelay: 60 });
      await queue.createQueue('nothing', { retryLimit: 0 });
      for (const n of [1, 2]) {
        await queue.send('object', null, { id: id(n) });
      }
      await queue.send('nothing', null, { id: id(3) });
      const release = Promise.withResolvers<void>();
      await queue.work(
        'object',
        { batchSize: 2, perJobResults: true },
        async () => {
          await release.promise;
          return { id: id(1), status: 'completed' };
        },
      );
      await queue.work('nothing', { perJobResults: true }, async () => {
        await release.promise;
      });
      await flush(clock);
      await clock.tick(5000);
      await queue.fail('object', id(2), { external: 1 });
      release.resolve();
      await flush(clock);
      return {
        object: await settledJobs(queue, 'object'),
        nothing: await settledJobs(queue, 'nothing'),
      };
    });

    // A non-array result fails the batch's claimed attempts with one error
    // (manager.js:356-363), so a job failed while the handler ran keeps the
    // output that failure stored.
    const notAnArray = {
      name: 'Error',
      message:
        'perJobResults handler must resolve with an array of job results',
      hasStack: true,
    };
    assert.deepStrictEqual(observed, {
      object: [
        {
          id: id(1),
          state: 'retry',
          startAfter: 65_000,
          completedOn: null,
          output: notAnArray,
        },
        {
          id: id(2),
          state: 'retry',
          startAfter: 65_000,
          completedOn: null,
          output: { external: 1 },
        },
      ],
      nothing: [
        {
          id: id(3),
          state: 'failed',
          startAfter: 0,
          completedOn: 5000,
          output: notAnArray,
        },
      ],
    });
  });

  it('settle the completed, then the failed, then the dead-lettered jobs, each group on its own', async () => {
    // An output whose toJSON throws stops its group before any write; which
    // jobs had already settled shows the order.
    const unserializable = {
      toJSON() {
        throw new Error('unserializable');
      },
    };
    const results = {
      first: [
        { id: id(1), status: 'completed', output: unserializable },
        { id: id(2), status: 'failed', output: { why: 'x' } },
        { id: id(3), status: 'deadletter', output: { dl: 1 } },
      ],
      second: [
        { id: id(4), status: 'completed', output: { ok: 1 } },
        { id: id(5), status: 'failed', output: unserializable },
        { id: id(6), status: 'deadletter', output: { dl: 1 } },
      ],
      third: [
        { id: id(7), status: 'completed', output: { ok: 1 } },
        { id: id(8), status: 'failed', output: { why: 'x' } },
        { id: id(9), status: 'deadletter', output: unserializable },
      ],
    };
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        await queue.createQueue('dlq');
        for (const [name, result] of Object.entries(results)) {
          await queue.createQueue(name, {
            retryLimit: 1,
            retryDelay: 60,
            deadLetter: 'dlq',
          });
          for (const { id: jobId } of result) {
            await queue.send(name, null, { id: jobId });
          }
          await queue.work(
            name,
            { batchSize: 3, perJobResults: true },
            async () => result,
          );
        }
        await flush(clock);
        return {
          first: await settledJobs(queue, 'first'),
          second: await settledJobs(queue, 'second'),
          third: await settledJobs(queue, 'third'),
          copies: await copies(queue, 'dlq'),
          errors: errors.map((error) => error.message),
        };
      },
    );

    // Three statements, not one transaction (manager.js:392-394): a group that
    // throws leaves the groups before it settled, and the batch's failure
    // (manager.js:639-655) then fails only what is still active, as a plain
    // fail, so a dead-letter disposition never landed is retried.
    const thrown = {
      name: 'Error',
      message: 'unserializable',
      hasStack: true,
    };
    const job = (n: number, state: string, output: unknown) => ({
      id: id(n),
      state,
      startAfter: state === 'retry' ? 60_000 : 0,
      completedOn: state === 'retry' ? null : 0,
      output,
    });
    assert.deepStrictEqual(observed, {
      first: [
        job(1, 'retry', thrown),
        job(2, 'retry', thrown),
        job(3, 'retry', thrown),
      ],
      second: [
        job(4, 'completed', { ok: 1 }),
        job(5, 'retry', thrown),
        job(6, 'retry', thrown),
      ],
      third: [
        job(7, 'completed', { ok: 1 }),
        job(8, 'retry', { why: 'x' }),
        job(9, 'retry', thrown),
      ],
      copies: [],
      errors: [],
    });
  });

  it('settle each disposition only at the attempt its worker claimed', async () => {
    const statuses = ['completed', 'failed', 'deadletter'];
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('dlq');
      await queue.createQueue('jobs', { retryLimit: 2, deadLetter: 'dlq' });
      for (const n of [1, 2, 3]) {
        await queue.send('jobs', null, { id: id(n) });
      }
      const releases = new Map<number, PromiseWithResolvers<void>>();
      await queue.work(
        'jobs',
        { localConcurrency: 2, batchSize: 3, perJobResults: true },
        async (jobs) => {
          const attempt = jobs[0]?.retryCount ?? -1;
          const release = Promise.withResolvers<void>();
          releases.set(attempt, release);
          await release.promise;
          return jobs
            .toSorted((a, b) => a.id.localeCompare(b.id))
            .map((job, index) => ({
              id: job.id,
              status: attempt === 0 ? statuses[index] : 'completed',
              output: { attempt },
            }));
        },
      );
      await flush(clock);
      // An unfenced fail() puts each claimed job back in retry while its
      // handler still runs; the idle loop claims them again at the next poll.
      await queue.fail('jobs', [id(1), id(2), id(3)]);
      await clock.tick(2000);
      await flush(clock);
      const read = async () => {
        const jobs = await queue.findJobs('jobs');
        return jobs
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((job) => ({
            id: job.id,
            state: job.state,
            retryCount: job.retryCount,
            output: job.output,
          }));
      };
      const reclaimed = await read();
      releases.get(0)?.resolve();
      await flush(clock);
      const afterStale = {
        jobs: await read(),
        copies: await copies(queue, 'dlq'),
      };
      releases.get(1)?.resolve();
      await flush(clock);
      return { reclaimed, afterStale, afterCurrent: await read() };
    });

    // Each group's statement matches (id, retry_count) of an active job
    // (plans.js:2147, 2650, 2663), so attempt 0's dispositions land nowhere
    // once attempt 1 holds the jobs.
    const all = (state: string, output: unknown) =>
      [1, 2, 3].map((n) => ({ id: id(n), state, retryCount: 1, output }));
    assert.deepStrictEqual(observed, {
      reclaimed: all('active', null),
      afterStale: { jobs: all('active', null), copies: [] },
      afterCurrent: all('completed', { attempt: 1 }),
    });
  });

  it("store a group's outputs as one JSON payload of mapped outputs", async () => {
    const results = {
      // toJSON's text is an output of its own, not JSON to parse, and
      // nothing from toJSON is no output.
      text: [
        { id: id(1), status: 'completed', output: { toJSON: () => '{"a":1}' } },
        { id: id(2), status: 'failed', output: { toJSON: () => '{"b":2}' } },
        { id: id(5), status: 'completed', output: { toJSON: () => undefined } },
      ],
      // Every output is mapped before the payload is stringified, so the
      // second output's throw wins over the first's unserializable BigInt.
      mappedFirst: [
        { id: id(3), status: 'completed', output: { toJSON: () => [1n] } },
        {
          id: id(4),
          status: 'completed',
          output: {
            toJSON() {
              throw new Error('unserializable');
            },
          },
        },
      ],
    };
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      for (const [name, result] of Object.entries(results)) {
        await queue.createQueue(name, { retryLimit: 1, retryDelay: 60 });
        for (const { id: jobId } of result) {
          await queue.send(name, null, { id: jobId });
        }
        await queue.work(
          name,
          { batchSize: 3, perJobResults: true },
          async () => result,
        );
      }
      await flush(clock);
      return {
        text: await settledJobs(queue, 'text'),
        mappedFirst: await settledJobs(queue, 'mappedFirst'),
      };
    });

    // A group binds its outputs as one JSON recordset: each mapped through
    // mapCompletionDataArg, then the payload stringified, then read row by row
    // into jsonb (manager.js:412, 422, 447, 451; plans.js:2137, 2654, 2667), so
    // a toJSON string is stored as a JSON string.
    const thrown = {
      name: 'Error',
      message: 'unserializable',
      hasStack: true,
    };
    assert.deepStrictEqual(observed, {
      text: [
        {
          id: id(1),
          state: 'completed',
          startAfter: 0,
          completedOn: 0,
          output: '{"a":1}',
        },
        {
          id: id(2),
          state: 'retry',
          startAfter: 60_000,
          completedOn: null,
          output: '{"b":2}',
        },
        {
          id: id(5),
          state: 'completed',
          startAfter: 0,
          completedOn: 0,
          output: null,
        },
      ],
      mappedFirst: [3, 4].map((n) => ({
        id: id(n),
        state: 'retry',
        startAfter: 60_000,
        completedOn: null,
        output: thrown,
      })),
    });
  });
});
