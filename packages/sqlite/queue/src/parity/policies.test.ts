import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type SendOptions, type TestClock, policies } from 'pg-boss';

import type { JobQueue } from '../index.ts';
import { ParityRun } from './backends.ts';
import { Observe } from './observe.ts';
import { Parity } from './parity.ts';

// What a call did: its result, or the error class and message it rejected
// with, plus a driver error's SQLSTATE.
async function outcome(call: () => Promise<unknown>) {
  try {
    return await call();
  } catch (error) {
    if (!(error instanceof Error)) {
      return String(error);
    }
    const code =
      error.name === 'error' && 'code' in error ? ` (${error.code})` : '';
    return `${error.name}: ${error.message}${code}`;
  }
}

// { ...options, singletonKey }: pg-boss reads an undefined key as no key,
// which its types cannot hold under exactOptionalPropertyTypes.
const keyed = (options: SendOptions, singletonKey: string | undefined) => {
  Reflect.set(options, 'singletonKey', singletonKey);
  return options;
};

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// Each job's id and state, in id order.
async function jobStates(queue: JobQueue, name: string) {
  return (await queue.findJobs(name))
    .map((job) => ({ id: job.id, state: job.state }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// One poll's worth of time. Both backends poll every 2s by default
// (node_modules/pg-boss/dist/attorney.js:587-589) and only on tick(), which
// returns once each one's fetches settle (clock.js:88-117).
async function poll(clock: TestClock) {
  await clock.tick(2000);
}

// Polls until the condition holds, at most five times.
async function pollUntil(clock: TestClock, isDone: () => boolean) {
  for (let polls = 0; polls < 5 && !isDone(); polls++) {
    await poll(clock);
  }
}

// The policies whose batch fetch claims one job per key (plans.js:1842).
const singletonFetchPolicies = [policies.singleton, policies.stately];

describe('queue policies and throttling', () => {
  it('lets each policy accept or refuse a second job for a key at send, as pg-boss does', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      const results: Record<string, unknown> = {};
      let n = 0;
      for (const [index, policy] of Object.values(policies).entries()) {
        await queue.createQueue(policy, { policy });
        const first = id(++n);
        const sends = {
          first: await outcome(() =>
            queue.send(policy, { n }, { id: first, singletonKey: 'k' }),
          ),
          second: await outcome(() =>
            queue.send(policy, { n }, { id: id(++n), singletonKey: 'k' }),
          ),
          otherKey: await outcome(() =>
            queue.send(policy, { n }, { id: id(++n), singletonKey: 'other' }),
          ),
          noKey: await outcome(() =>
            queue.send(policy, { n }, { id: id(++n) }),
          ),
        };
        // fail() moves a job that never ran to retry while it has retries
        // left (plans.js:2367-2370, 2433-2436).
        await queue.fail(policy, first);
        results[policy] = {
          ...sends,
          afterRetry: await outcome(() =>
            queue.send(
              policy,
              { n },
              { id: id(101 + index), singletonKey: 'k' },
            ),
          ),
        };
      }
      return results;
    });

    // Per pg-boss's unique indexes (plans.js:882-893, 921-925): short allows one
    // created job per key, singleton one active (so queued duplicates pass),
    // stately one per state, exclusive one queued, retrying or active,
    // key_strict_fifo one active, retrying or failed, and refuses a job without
    // a key. Once the first job retries, only exclusive refuses another.
    const accepted = (first: number) => ({
      first: id(first),
      second: id(first + 1),
      otherKey: id(first + 2),
      noKey: id(first + 3),
    });
    assert.deepStrictEqual(observed, {
      standard: { ...accepted(1), afterRetry: id(101) },
      short: { ...accepted(5), second: null, afterRetry: id(102) },
      singleton: { ...accepted(9), afterRetry: id(103) },
      stately: { ...accepted(13), second: null, afterRetry: id(104) },
      exclusive: { ...accepted(17), second: null, afterRetry: null },
      key_strict_fifo: {
        ...accepted(21),
        noKey: 'Error: key_strict_fifo queues require a singletonKey',
        afterRetry: id(106),
      },
    });
  });

  it('throttles sends into singletonSeconds slots, and singletonNextSlot into the next', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await clock.setTime('2026-01-01T00:00:10.000Z');
      const send = async (n: number, options: object) => {
        const sent = await queue.send('jobs', { n }, { id: id(n), ...options });
        if (sent === null) {
          return null;
        }
        const [job] = await queue.findJobs('jobs', { id: sent });
        assert.ok(job, `job ${n} was not stored`);
        const row = Observe.job(job);
        return { startAfter: row.startAfter, singletonOn: row.singletonOn };
      };
      const sends = {
        first: await send(1, { singletonKey: 'k', singletonSeconds: 60 }),
        sameSlot: await send(2, { singletonKey: 'k', singletonSeconds: 60 }),
        sameSlotNotNext: await send(8, {
          singletonKey: 'k',
          singletonSeconds: 60,
          singletonNextSlot: false,
        }),
        otherKey: await send(3, { singletonKey: 'x', singletonSeconds: 60 }),
        nextSlot: await send(4, {
          singletonKey: 'k',
          singletonSeconds: 60,
          singletonNextSlot: true,
        }),
        noKey: await send(5, { singletonSeconds: 60 }),
        noKeyAgain: await send(6, { singletonSeconds: 60 }),
        zeroWidth: await outcome(() =>
          queue.send('jobs', { n: 7 }, { id: id(7), singletonSeconds: 0 }),
        ),
      };
      await queue.cancel('jobs', id(1));
      const afterCancel = await send(9, {
        singletonKey: 'k',
        singletonSeconds: 60,
      });
      // Half a second into a minute, a negative width's next slot starts now,
      // which manager.js:1538 bumps to one second.
      await clock.setTime('2026-01-01T00:01:00.500Z');
      const negativeWidth = await send(10, {
        singletonKey: 'n',
        singletonSeconds: -60,
      });
      const negativeNextSlot = await send(11, {
        singletonKey: 'n',
        singletonSeconds: -60,
        singletonNextSlot: true,
      });
      return { ...sends, afterCancel, negativeWidth, negativeNextSlot };
    });

    // The slot is 00:00 UTC stored without a zone and read back in the suite's
    // pinned zone (UTC+05:30), as the Postgres drivers read it.
    const slot = -(5 * 60 + 30) * 60 * 1000;
    assert.deepStrictEqual(observed, {
      first: { startAfter: 10_000, singletonOn: slot },
      sameSlot: null,
      sameSlotNotNext: null,
      otherKey: { startAfter: 10_000, singletonOn: slot },
      nextSlot: { startAfter: 61_000, singletonOn: slot + 60_000 },
      noKey: { startAfter: 10_000, singletonOn: slot },
      noKeyAgain: null,
      zeroWidth: 'error: division by zero (22012)',
      // A cancelled job gives its slot back (plans.js:891-893).
      afterCancel: { startAfter: 10_000, singletonOn: slot },
      negativeWidth: { startAfter: 60_500, singletonOn: slot + 120_000 },
      negativeNextSlot: { startAfter: 61_500, singletonOn: slot + 60_000 },
    });
  });

  it('keeps a job queued, without an error, while its key runs on a singleton or stately queue', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        const results: Record<string, unknown> = {};
        let n = 0;
        for (const policy of singletonFetchPolicies) {
          await queue.createQueue(policy, { policy });
          await queue.send(policy, null, { id: id(++n), singletonKey: 'k' });
          const release = Promise.withResolvers<void>();
          const started: string[] = [];
          const firstStarted = Promise.withResolvers<void>();
          await queue.work(policy, { localConcurrency: 2 }, async ([job]) => {
            started.push(job?.id ?? '');
            firstStarted.resolve();
            await release.promise;
          });
          try {
            await firstStarted.promise;
            const queued = await queue.send(policy, null, {
              id: id(++n),
              singletonKey: 'k',
            });
            // The idle slot tries to claim the queued job while the key runs.
            await poll(clock);
            const whileHeld = await jobStates(queue, policy);
            release.resolve();
            await pollUntil(clock, () => started.length >= 2);
            results[policy] = { queued, whileHeld, started };
          } finally {
            release.resolve();
          }
        }
        return { ...results, errors: errors.map((error) => error.message) };
      },
    );

    // pg-boss's fetch claims the queued job, the policy's unique index refuses
    // it, and the worker treats that as an empty fetch (manager.js:1580-1586).
    assert.deepStrictEqual(observed, {
      singleton: {
        queued: id(2),
        whileHeld: [
          { id: id(1), state: 'active' },
          { id: id(2), state: 'created' },
        ],
        started: [id(1), id(2)],
      },
      stately: {
        queued: id(4),
        whileHeld: [
          { id: id(3), state: 'active' },
          { id: id(4), state: 'created' },
        ],
        started: [id(3), id(4)],
      },
      errors: [],
    });
  });

  it('starts one job per key in a batch on singleton and stately queues', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      const results: Record<string, unknown> = {};
      let n = 0;
      for (const policy of singletonFetchPolicies) {
        await queue.createQueue(policy, { policy });
        // Two fetchable jobs per key, keyless included: failing the first
        // into retry lets stately queue a second one beside it.
        for (const singletonKey of ['a', undefined]) {
          const first = await queue.send(
            policy,
            null,
            keyed({ id: id(++n) }, singletonKey),
          );
          await queue.fail(policy, first ?? '');
          await queue.send(policy, null, keyed({ id: id(++n) }, singletonKey));
        }
        await queue.send(policy, null, { id: id(++n), singletonKey: 'b' });
        const release = Promise.withResolvers<void>();
        let batchSize: number | null = null;
        await queue.work(policy, { batchSize: 10 }, async (jobs) => {
          batchSize = jobs.length;
          await release.promise;
        });
        try {
          await pollUntil(clock, () => batchSize !== null);
          // A worker's jobs carry no singletonKey (pg-boss's minimal
          // columns), so the running keys are read back.
          const running = (await queue.findJobs(policy))
            .filter((job) => job.state === 'active')
            .map((job) => job.singletonKey)
            .sort();
          results[policy] = { batchSize, running };
        } finally {
          release.resolve();
        }
      }

      // An empty key and no key rank apart, but the singleton index reads
      // both as '' (COALESCE), so their batch clashes and claims nothing.
      await queue.createQueue('blank', { policy: policies.singleton });
      await queue.send('blank', null, { id: id(++n), singletonKey: '' });
      await queue.send('blank', null, { id: id(n + 1) });
      let blankBatchSize: number | null = null;
      await queue.work('blank', { batchSize: 10 }, async (jobs) => {
        blankBatchSize = jobs.length;
      });
      await pollUntil(clock, () => blankBatchSize !== null);
      results.blank = {
        batchSize: blankBatchSize,
        states: await jobStates(queue, 'blank'),
      };
      return results;
    });

    // pg-boss ranks a singleton or stately batch by singleton_key and claims
    // the first of each (plans.js:1842, 1971-1975, 2026).
    assert.deepStrictEqual(observed, {
      singleton: { batchSize: 3, running: ['a', 'b', null] },
      stately: { batchSize: 3, running: ['a', 'b', null] },
      blank: {
        batchSize: null,
        states: [
          { id: id(11), state: 'created' },
          { id: id(12), state: 'created' },
        ],
      },
    });
  });

  it('starts only the head job of each key on a key_strict_fifo queue, skipping keys held by an active, retrying or failed job', async () => {
    const [a1, a2, b1, c1, c2, d1, d2, e1, f1, f2, g1, g2, h1, h2] = [
      id(1),
      id(2),
      id(3),
      id(4),
      id(5),
      id(6),
      id(7),
      id(8),
      id(9),
      id(10),
      id(11),
      id(12),
      id(13),
      id(14),
    ];
    const observed = await Parity.assertSame(async ({ queue, clock }) => {
      await queue.start();
      const name = policies.key_strict_fifo;
      await queue.createQueue(name, { policy: name });
      await queue.send(name, null, { id: a1, singletonKey: 'a' });
      await queue.send(name, null, { id: a2, singletonKey: 'a' });
      await queue.send(name, null, { id: b1, singletonKey: 'b' });
      await queue.send(name, null, {
        id: c1,
        singletonKey: 'c',
        retryLimit: 0,
      });
      await queue.fail(name, c1);
      await queue.send(name, null, { id: c2, singletonKey: 'c' });
      // The younger d2 retries, so it heads d over the older d1.
      await queue.send(name, null, { id: d1, singletonKey: 'd' });
      await queue.send(name, null, { id: d2, singletonKey: 'd' });
      await queue.fail(name, d2);
      // f1 retries only after a minute, and holds f until then.
      await queue.send(name, null, {
        id: f1,
        singletonKey: 'f',
        retryDelay: 60,
      });
      await queue.fail(name, f1);
      await queue.send(name, null, { id: f2, singletonKey: 'f' });
      // g1 is deferred for a minute, so the due g2 heads g.
      await queue.send(name, null, {
        id: g1,
        singletonKey: 'g',
        startAfter: 60,
      });
      await queue.send(name, null, { id: g2, singletonKey: 'g' });
      // h2 is sent after h1 but stamped earlier, so it heads h: a key's
      // order is created_on, not send order or id.
      await clock.setTime('2026-01-01T00:00:05.000Z');
      await queue.send(name, null, {
        id: h1,
        singletonKey: 'h',
        startAfter: new Date(ParityRun.start),
      });
      await clock.setTime(ParityRun.start);
      await queue.send(name, null, { id: h2, singletonKey: 'h' });

      const batches: string[][] = [];
      const release = Promise.withResolvers<void>();
      await queue.work(
        name,
        { batchSize: 10, localConcurrency: 2 },
        async (jobs) => {
          batches.push(jobs.map((job) => job.id).sort());
          await release.promise;
        },
      );
      try {
        const until = (count: number) =>
          pollUntil(clock, () => batches.length >= count);
        await until(1);
        // While the heads run, the idle slot claims a new key but none of
        // the held ones.
        await queue.send(name, null, { id: e1, singletonKey: 'e' });
        await until(2);
        release.resolve();
        await until(3);
        await poll(clock);
        const waiting = (await jobStates(queue, name)).filter((job) =>
          [c1, c2, f1, f2, g1].includes(job.id),
        );
        return { batches, waiting };
      } finally {
        release.resolve();
      }
    });

    // A key's head is its due retry job, else its oldest due job, and it
    // waits while a sibling is active, retrying or failed (plans.js:1900-1917,
    // 1929-1939).
    assert.deepStrictEqual(observed, {
      batches: [[a1, b1, d2, g2, h2], [e1], [a2, d1, h1]],
      waiting: [
        { id: c1, state: 'failed' },
        { id: c2, state: 'created' },
        { id: f1, state: 'retry' },
        { id: f2, state: 'created' },
        { id: g1, state: 'created' },
      ],
    });
  });

  it('refuses to fail a second key_strict_fifo job of a key while the first is retrying', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      const name = policies.key_strict_fifo;
      await queue.createQueue(name, { policy: name });
      await queue.send(name, null, { id: id(1), singletonKey: 'k' });
      await queue.send(name, null, { id: id(2), singletonKey: 'k' });
      await queue.fail(name, id(1));
      const secondFail = await outcome(() => queue.fail(name, id(2)));
      return { secondFail, states: await jobStates(queue, name) };
    });

    // job_i8 holds one active, retrying or failed job per key
    // (plans.js:924-926), so the second job can join the first neither in
    // retry nor, failing over, in failed: the call rolls back
    // (plans.js:2532-2609).
    assert.deepStrictEqual(observed, {
      secondFail:
        'error: duplicate key value violates unique constraint "job_common_i8" (23505)',
      states: [
        { id: id(1), state: 'retry' },
        { id: id(2), state: 'created' },
      ],
    });
  });
});
