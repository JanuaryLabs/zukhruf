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

// What a call did: its result, or the error class, message and SQLSTATE it
// rejected with.
async function outcome(call: () => Promise<unknown>) {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof Error)) {
      return String(error);
    }
    const code = 'code' in error ? ` (${error.code})` : '';
    return `${error.name}: ${error.message}${code}`;
  }
}

// A dead letter copy observed without its random id.
function copy(job: object) {
  return Object.fromEntries(
    Object.entries(Observe.job(job)).filter(([key]) => key !== 'id'),
  );
}

// A serialized error with its stack replaced by whether it was there, since
// stacks differ by backend and line.
function withoutStack(output: unknown) {
  if (output === null || typeof output !== 'object' || !('stack' in output)) {
    return output;
  }
  const { stack, ...rest } = output;
  return { ...rest, hasStack: typeof stack === 'string' };
}

describe('fail', () => {
  it('put a job back in retry after its delay or a jittered backoff, without spending an attempt', async () => {
    const queues = {
      plain: { retryDelay: 7 },
      backoffFromZero: { retryBackoff: true, retryDelay: 0 },
      backoffFromFour: { retryBackoff: true, retryDelay: 4 },
      capped: { retryBackoff: true, retryDelay: 4, retryDelayMax: 3 },
      cappedAtZero: { retryBackoff: true, retryDelay: 4, retryDelayMax: 0 },
    };
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      const origin = Date.parse(ParityRun.start);
      for (const [n, [name, options]] of Object.entries(queues).entries()) {
        await queue.createQueue(name, { retryLimit: 3, ...options });
        await queue.send(name, null, { id: id(n + 1) });
      }
      await clock.tick(1000);
      await queue.fail('plain', id(1));
      await clock.tick(1000);
      const failedAt = clock.now() - origin;
      for (const [n, name] of Object.keys(queues).entries()) {
        await queue.fail(name, id(n + 1));
      }
      const delays: Record<string, unknown> = {};
      for (const name of Object.keys(queues)) {
        const [job] = await queue.findJobs(name);
        delays[name] = {
          state: job?.state,
          retryCount: job?.retryCount,
          delay: job ? job.startAfter.getTime() - origin - failedAt : null,
          completedOn: job?.completedOn ?? null,
        };
      }
      // Jitter makes a backoff delay random, so it is compared by range.
      const within = (name: string, low: number, high: number) => {
        const entry = delays[name];
        const delay =
          entry !== null && typeof entry === 'object' && 'delay' in entry
            ? entry.delay
            : null;
        return typeof delay === 'number' && delay >= low && delay < high;
      };
      return {
        plain: delays.plain,
        capped: delays.capped,
        cappedAtZero: delays.cappedAtZero,
        backoff: {
          fromZero: within('backoffFromZero', 1000, 2000),
          fromFour: within('backoffFromFour', 4000, 8000),
        },
      };
    });

    // fail() leaves retry_count alone (only a claim spends an attempt) and
    // waits retry_delay, or with backoff max(delay, 1)·2^e/2·(1 + random())
    // with e = min(16, retry_count + 1), capped by retryDelayMax
    // (node_modules/pg-boss/dist/plans.js:2433-2436, 2494-2503).
    assert.deepStrictEqual(observed, {
      plain: { state: 'retry', retryCount: 0, delay: 7000, completedOn: null },
      capped: { state: 'retry', retryCount: 0, delay: 3000, completedOn: null },
      cappedAtZero: {
        state: 'retry',
        retryCount: 0,
        delay: 0,
        completedOn: null,
      },
      backoff: { fromZero: true, fromFour: true },
    });
  });

  it("back a worker's retry off twice as far with each attempt the job spent", async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      const origin = Date.parse(ParityRun.start);
      const failures: { attempt: number; at: number }[] = [];
      await queue.createQueue('jobs', {
        retryBackoff: true,
        retryDelay: 4,
        retryLimit: 3,
      });
      await queue.send('jobs', null, { id: id(1) });
      await queue.work('jobs', async ([job]) => {
        failures.push({
          attempt: job?.retryCount ?? -1,
          at: clock.now() - origin,
        });
        throw new Error('boom');
      });
      await flush(clock);
      // The claim, the throw and its fail run under one clock reading on both
      // backends, so each delay is measured from that failure's own time; the
      // retry is not due before it is read, and the 2 s poll claims it once
      // it is.
      const delays: number[] = [];
      for (let spent = 1; spent <= 3; spent++) {
        const [job] = await queue.findJobs('jobs');
        const failedAt = failures[spent - 1]?.at ?? 0;
        delays.push(job ? job.startAfter.getTime() - origin - failedAt : -1);
        while (failures.length === spent && clock.now() - origin < 120_000) {
          await clock.tick(2000);
          await flush(clock);
        }
      }
      const [job] = await queue.findJobs('jobs');
      return {
        attempts: failures.map(({ attempt }) => attempt),
        // Jitter makes each delay random, so it is compared by range.
        withinRange: delays.map(
          (delay, attempt) =>
            delay >= 4000 * 2 ** attempt && delay < 8000 * 2 ** attempt,
        ),
        final: { state: job?.state, retryCount: job?.retryCount },
      };
    });

    // Each claim of a started job spends an attempt (plans.js:2023), and the
    // backoff's exponent is min(16, retry_count + 1), so a delay of
    // max(retry_delay, 1)·2^e/2·(1 + random()) lands in [4, 8) s, then
    // [8, 16) s, then [16, 32) s; the last attempt fails for good
    // (plans.js:2433-2436, 2494-2503).
    assert.deepStrictEqual(observed, {
      attempts: [0, 1, 2, 3],
      withinRange: [true, true, true],
      final: { state: 'failed', retryCount: 3 },
    });
  });

  it('copy a job that fails for good into its dead letter queue, with its lineage', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('dlq', {
        retentionSeconds: 100,
        retryLimit: 3,
        retryDelay: 9,
      });
      await queue.createQueue('source', { retryLimit: 0, deadLetter: 'dlq' });
      await queue.createQueue('retrying', { retryLimit: 1, deadLetter: 'dlq' });
      await queue.send(
        'source',
        { a: 1 },
        { id: id(1), singletonKey: 'k', priority: 2 },
      );
      await queue.send('retrying', null, { id: id(2) });
      await clock.tick(1000);
      const failed = await queue.fail('source', id(1), { boom: 1 });
      await queue.fail('retrying', id(2));
      const [source] = await queue.findJobs('source');
      const copies = await queue.findJobs('dlq');
      // The copy has an id of its own that finds it.
      const copyIds = await Promise.all(
        copies.map(
          async (job) =>
            job.id !== id(1) &&
            (await queue.findJobs('dlq', { id: job.id }))[0]?.id === job.id,
        ),
      );
      return {
        failed,
        copyIds,
        source: source ? Observe.job(source) : null,
        copies: copies.map(copy),
        retrying: (await queue.findJobs('retrying')).map((job) => job.state),
      };
    });

    // A job that ends failed is copied into dead_letter as a new created job
    // that takes its retry settings and retention from that queue and keeps
    // the job's data, key, priority and lineage; a retry is not copied
    // (plans.js:2615-2643).
    const { failed, copyIds, source, copies, retrying } = observed;
    assert.deepStrictEqual(
      { failed, copyIds, retrying, sourceState: source?.state },
      {
        failed: { jobs: [id(1)], requested: 1, affected: 1, settled: [id(1)] },
        copyIds: [true],
        retrying: ['retry'],
        sourceState: 'failed',
      },
    );
    assert.partialDeepStrictEqual(copies, [
      {
        name: 'dlq',
        data: { a: 1 },
        state: 'created',
        priority: 2,
        singletonKey: 'k',
        retryLimit: 3,
        retryDelay: 9,
        startAfter: 1000,
        createdOn: 1000,
        keepUntil: 101_000,
        policy: null,
        deadLetter: null,
        output: null,
        sourceName: 'source',
        sourceId: id(1),
        sourceCreatedOn: 0,
        sourceRetryCount: 0,
        sourceOutput: { boom: 1 },
        sourceRootId: id(1),
      },
    ]);
  });

  it("give a dead letter copy its dead letter queue's settings, not its own queue's", async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('final');
      await queue.createQueue('dlq', {
        retryLimit: 6,
        retryDelay: 5,
        retryBackoff: true,
        retryDelayMax: 50,
        expireInSeconds: 120,
        retentionSeconds: 500,
        deleteAfterSeconds: 30,
        heartbeatSeconds: 40,
        deadLetter: 'final',
      });
      // The first throw's retry is due at once; the next poll claims it and
      // the second throw fails the job's last attempt.
      await queue.createQueue('source', {
        retryLimit: 1,
        expireInSeconds: 60,
        retentionSeconds: 300,
        deleteAfterSeconds: 20,
        heartbeatSeconds: 20,
        deadLetter: 'dlq',
      });
      await queue.send(
        'source',
        { a: 1 },
        { id: id(1), priority: 3, singletonKey: 'k' },
      );
      await queue.work('source', async () => {
        throw new Error('boom');
      });
      await flush(clock);
      await clock.tick(2000);
      await flush(clock);
      const [source] = await queue.findJobs('source');
      return {
        source: source && {
          state: source.state,
          retryCount: source.retryCount,
        },
        copies: (await queue.findJobs('dlq')).map((job) => {
          const { sourceOutput, ...rest } = copy(job);
          return { ...rest, sourceOutput: withoutStack(sourceOutput) };
        }),
        final: (await queue.findJobs('final')).length,
      };
    });

    // The copy takes retry, expiry, retention, deletion and heartbeat from
    // the dead letter queue, never its retryDelayMax or deadLetter, so a copy
    // never chains on; the failing attempt's retry_count is its lineage
    // (plans.js:2615-2643).
    assert.deepStrictEqual(observed, {
      source: { state: 'failed', retryCount: 1 },
      copies: [
        {
          name: 'dlq',
          data: { a: 1 },
          expireInSeconds: 120,
          heartbeatSeconds: 40,
          groupId: null,
          groupTier: null,
          priority: 3,
          state: 'created',
          retryLimit: 6,
          retryCount: 0,
          retryDelay: 5,
          retryBackoff: true,
          retryDelayMax: null,
          startAfter: 2000,
          startedOn: null,
          singletonKey: 'k',
          singletonOn: null,
          deleteAfterSeconds: 30,
          createdOn: 2000,
          completedOn: null,
          keepUntil: 502_000,
          policy: null,
          heartbeatOn: null,
          deadLetter: null,
          output: null,
          blocked: false,
          blocking: false,
          pendingDependencies: 0,
          sourceName: 'source',
          sourceId: id(1),
          sourceCreatedOn: 0,
          sourceRetryCount: 1,
          sourceOutput: { name: 'Error', message: 'boom', hasStack: true },
          sourceRootId: id(1),
        },
      ],
      final: 0,
    });
  });

  it('fail a stately job for good when its key already has a job in retry', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('dlq');
      await queue.createQueue('stately', {
        policy: 'stately',
        retryDelay: 7,
        deadLetter: 'dlq',
      });
      await queue.send('stately', null, { id: id(1), singletonKey: 'k' });
      await queue.fail('stately', id(1));
      await queue.send('stately', null, { id: id(2), singletonKey: 'k' });
      const release = Promise.withResolvers<void>();
      await queue.work('stately', {}, async () => release.promise);
      await flush(clock);
      await clock.tick(3000);
      const failed = await outcome(() =>
        queue.fail('stately', id(2), { boom: 1 }),
      );
      const jobs = await queue.findJobs('stately');
      release.resolve();
      await flush(clock);
      return {
        failed,
        jobs: jobs
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((job) => {
            const {
              id: jobId,
              state,
              startAfter,
              completedOn,
              output,
            } = Observe.job(job);
            return { id: jobId, state, startAfter, completedOn, output };
          }),
        copies: (await queue.findJobs('dlq')).map(
          (job) => Observe.job(job).sourceId,
        ),
      };
    });

    // The retry re-insert the key's index refuses falls back to failed,
    // forfeiting the retries left and dead-lettering the job
    // (plans.js:2529, 2607).
    assert.deepStrictEqual(observed, {
      failed: { jobs: [id(2)], requested: 1, affected: 1, settled: [id(2)] },
      jobs: [
        {
          id: id(1),
          state: 'retry',
          startAfter: 7000,
          completedOn: null,
          output: null,
        },
        {
          id: id(2),
          state: 'failed',
          startAfter: 0,
          completedOn: 3000,
          output: { boom: 1 },
        },
      ],
      copies: [id(2)],
    });
  });

  it('refuse a dead letter queue that does not exist, or that a queue still uses', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('dlq');
      await queue.createQueue('jobs', { deadLetter: 'dlq' });
      await queue.createQueue('other');
      await queue.createQueue('jobDlq');
      await queue.send('other', null, { deadLetter: 'jobDlq' });
      return {
        send: await outcome(() =>
          queue.send('other', null, { deadLetter: 'nowhere' }),
        ),
        update: await outcome(() =>
          queue.updateQueue('other', { deadLetter: 'nowhere' }),
        ),
        deleteUsed: await outcome(() => queue.deleteQueue('dlq')),
        deleteUsedByJob: await outcome(() => queue.deleteQueue('jobDlq')),
        updateItself: await outcome(() =>
          queue.updateQueue('other', { deadLetter: 'other' }),
        ),
        otherJobs: (await queue.findJobs('other')).length,
      };
    });

    // dead_letter references queue(name) on both tables (plans.js:321,
    // 878-881), so the refused send stores nothing beside the accepted one.
    assert.deepStrictEqual(observed, {
      send: 'error: insert or update on table "job_common" violates foreign key constraint "dlq_fkey" (23503)',
      update:
        'error: insert or update on table "queue" violates foreign key constraint "queue_dead_letter_fkey" (23503)',
      deleteUsed:
        'error: update or delete on table "queue" violates foreign key constraint "queue_dead_letter_fkey" on table "queue" (23503)',
      deleteUsedByJob:
        'error: update or delete on table "queue" violates RESTRICT setting of foreign key constraint "dlq_fkey" on table "job_common" (23001)',
      updateItself:
        'AssertionError: deadLetter cannot be itself (ERR_ASSERTION)',
      otherJobs: 1,
    });
  });
});
