import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import {
  type Job,
  PgBoss,
  type SendOptions,
  type TestClock,
  fromPglite,
} from 'pg-boss';

import type { JobQueue } from '../index.ts';
import { SqliteJobQueue } from '../index.ts';
import { ParityRun, type RunOptions } from './backends.ts';
import { Observe } from './observe.ts';
import { Parity } from './parity.ts';

// { ...options, singletonKey }: pg-boss reads an undefined key as no key,
// which its types cannot hold under exactOptionalPropertyTypes.
const keyed = (options: SendOptions, singletonKey: string | undefined) => {
  Reflect.set(options, 'singletonKey', singletonKey);
  return options;
};

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

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

// Lets everything due now finish on both backends: tick(0) waits until each
// one's statements in flight have settled (node_modules/pg-boss/dist/
// clock.js:88-117).
async function flush(clock: TestClock) {
  await clock.tick(0);
}

const fields = [
  'state',
  'retryCount',
  'startedOn',
  'completedOn',
  'startAfter',
  'output',
  'heartbeatOn',
  'keepUntil',
] as const;

async function read(queue: JobQueue, name: string, n: number) {
  const [job] = await queue.findJobs(name, { id: id(n) });
  if (!job) {
    return null;
  }
  const observed = Observe.job(job);
  return Object.fromEntries(fields.map((key) => [key, observed[key]]));
}

// A handler that records each batch and every abort of its jobs' signals,
// and holds every batch until released.
function holding(clock: TestClock) {
  const batches: { at: number; ids: string[] }[] = [];
  const aborts: { id: string; at: number; reason: string }[] = [];
  const release = Promise.withResolvers<void>();
  return {
    batches,
    aborts,
    release: () => release.resolve(),
    handler: async (jobs: Job<unknown>[]) => {
      batches.push({
        at: clock.now() - origin,
        ids: jobs.map((job) => job.id).sort(),
      });
      for (const job of jobs) {
        job.signal.addEventListener('abort', () => {
          const reason: unknown = job.signal.reason;
          aborts.push({
            id: job.id,
            at: clock.now() - origin,
            reason: reason instanceof Error ? reason.message : String(reason),
          });
        });
      }
      await release.promise;
    },
  };
}

// An expireInSeconds 1 job batched with a 900 s one: the batch's deadline is
// the larger expiry, so only the supervisor can expire the short job
// (node_modules/pg-boss/dist/manager.js:520-535).
async function expiry(
  { queue, clock, errors }: ParityRun,
  createOptions: {
    retryLimit: number;
    retryDelay?: number;
    deadLetter?: string;
  },
) {
  await queue.start();
  await queue.createQueue('dlq');
  await queue.createQueue('jobs', createOptions);
  await queue.send('jobs', null, { id: id(1), expireInSeconds: 1 });
  await queue.send('jobs', null, { id: id(2), expireInSeconds: 900 });
  const held = holding(clock);
  await queue.work('jobs', { batchSize: 2 }, held.handler);
  try {
    await flush(clock);
    const timeline = [];
    for (const step of [999, 1, 999, 1]) {
      await clock.tick(step);
      timeline.push({
        at: clock.now() - origin,
        job: await read(queue, 'jobs', 1),
      });
    }
    const aborted = [...held.aborts];
    await clock.tick(1000);
    held.release();
    await flush(clock);
    const deadLetters = (await queue.findJobs('dlq')).map((job) => {
      const observed = Observe.job(job);
      return {
        state: observed.state,
        sourceId: observed.sourceId,
        sourceOutput: observed.sourceOutput,
        createdOn: observed.createdOn,
        keepUntil: observed.keepUntil,
      };
    });
    return {
      timeline,
      aborted,
      settled: [await read(queue, 'jobs', 1), await read(queue, 'jobs', 2)],
      aborts: [...held.aborts],
      deadLetters,
      errors: errors.map((error) => error.message),
    };
  } finally {
    held.release();
  }
}

const retention = 14 * 24 * 60 * 60 * 1000;

const active = {
  state: 'active',
  retryCount: 0,
  startedOn: 0,
  completedOn: null,
  startAfter: 0,
  output: null,
  heartbeatOn: 0,
  keepUntil: retention,
};

const timedOut = { value: { message: 'job timed out' } };

describe('supervisor', () => {
  it('fails an active job once it is strictly past its expiry, into retry, aborting nothing', async () => {
    const observed = await Parity.assertSame(
      (run) => expiry(run, { retryLimit: 1, retryDelay: 60 }),
      supervised,
    );

    // failJobsByTimeout: active AND started_on + expire_seconds < now
    // (plans.js:2372-2378), through failJobsBody's retry branch unfenced
    // (2430-2445). The handler keeps running; its completion is fenced out
    // and its signals abort only when the batch settles.
    const retried = {
      ...active,
      state: 'retry',
      startAfter: 62000,
      output: timedOut,
      heartbeatOn: null,
    };
    const abort = (n: number) => ({
      id: id(n),
      at: 3000,
      reason: 'This operation was aborted',
    });
    assert.deepStrictEqual(observed, {
      timeline: [
        { at: 999, job: active },
        { at: 1000, job: active },
        { at: 1999, job: active },
        { at: 2000, job: retried },
      ],
      aborted: [],
      settled: [retried, { ...active, state: 'completed', completedOn: 3000 }],
      aborts: [abort(1), abort(2)],
      deadLetters: [],
      errors: [],
    });
  });

  it('fails an expired job on its last attempt for good and copies it into its dead letter queue', async () => {
    const observed = await Parity.assertSame(
      (run) => expiry(run, { retryLimit: 0, deadLetter: 'dlq' }),
      supervised,
    );

    // failJobsBody's failed branch keeps start_after and dead-letters the
    // job with its output as source_output (plans.js:2433-2439, 2615-2643).
    const failed = {
      ...active,
      state: 'failed',
      completedOn: 2000,
      output: timedOut,
      heartbeatOn: null,
    };
    assert.deepStrictEqual(observed.timeline.at(-1), { at: 2000, job: failed });
    // The handler's completion at 3000 is fenced out (plans.js:2051-2054).
    assert.deepStrictEqual(observed.settled[0], failed);
    assert.deepStrictEqual(observed.deadLetters, [
      {
        state: 'created',
        sourceId: id(1),
        sourceOutput: timedOut,
        createdOn: 2000,
        keepUntil: 2000 + retention,
      },
    ]);
  });

  // pg-boss reads the key's presence (attorney.js:413); an explicit
  // undefined is outside its types under exactOptionalPropertyTypes.
  const supervisedUndefined: RunOptions = { ...supervised };
  Reflect.set(supervisedUndefined, 'supervise', undefined);
  for (const { label, options } of [
    { label: 'supervise: false', options: { ...supervised, supervise: false } },
    { label: 'supervise: undefined', options: supervisedUndefined },
  ]) {
    it(`leaves an expired job active with ${label}`, async () => {
      const observed = await Parity.assertSame(
        (run) => expiry(run, { retryLimit: 1, retryDelay: 60 }),
        options,
      );

      assert.deepStrictEqual(observed.timeline.at(-1), {
        at: 2000,
        job: active,
      });
      assert.deepStrictEqual(observed.settled, [
        { ...active, state: 'completed', completedOn: 3000 },
        { ...active, state: 'completed', completedOn: 3000 },
      ]);
    });
  }

  it('fails a job whose heartbeat is strictly overdue, and its next touch aborts it', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        for (const name of ['jobs', 'both']) {
          await queue.createQueue(name, {
            heartbeatSeconds: 10,
            retryDelay: 600,
          });
        }
        await queue.send('jobs', null, { id: id(1) });
        // Job 2 is past both its expiry and its heartbeat at 11000.
        await queue.send('both', null, { id: id(2), expireInSeconds: 10 });
        await queue.send('both', null, { id: id(3), expireInSeconds: 900 });
        const held = holding(clock);
        await queue.work('jobs', { heartbeatRefreshSeconds: 60 }, held.handler);
        await queue.work(
          'both',
          { batchSize: 2, heartbeatRefreshSeconds: 60 },
          held.handler,
        );
        try {
          await flush(clock);
          const timeline = [];
          for (const step of [10000, 1000, 48999, 1]) {
            await clock.tick(step);
            timeline.push({
              at: clock.now() - origin,
              job: await read(queue, 'jobs', 1),
              both: [
                await read(queue, 'both', 2),
                await read(queue, 'both', 3),
              ],
              aborts: held.aborts.filter((abort) => abort.id === id(1)),
            });
          }
          return { timeline, errors: errors.map((error) => error.message) };
        } finally {
          held.release();
        }
      },
      supervised,
    );

    // failJobsByHeartbeat: heartbeat_on + heartbeat_seconds < now
    // (plans.js:2379-2385); the worker's next touch finds the claim gone
    // (manager.js:537-566).
    const retried = {
      ...active,
      state: 'retry',
      startAfter: 611000,
      output: { value: { message: 'job heartbeat timeout' } },
      heartbeatOn: null,
    };
    const lost = {
      id: id(1),
      at: 60000,
      reason: `job ${id(1)} is no longer active under this worker's claim`,
    };
    // Expiry runs first in a pass (boss.js:368-378), so a job past both
    // stores the timeout.
    const both = [{ ...retried, output: timedOut }, retried];
    assert.deepStrictEqual(observed, {
      timeline: [
        { at: 10000, job: active, both: [active, active], aborts: [] },
        { at: 11000, job: retried, both, aborts: [] },
        { at: 59999, job: retried, both, aborts: [] },
        { at: 60000, job: retried, both, aborts: [lost] },
      ],
      errors: [],
    });
  });

  // Queues created before the first pass are claimed at odd seconds, and
  // one created at 1500 at even seconds (2 s intervals); each pass's expiry,
  // heartbeat and deletion cover only the queues it claimed (plans.js:
  // 973-990, 1119-1137, 2372-2386, 3055-3066).
  it('monitors and maintains each queue on its own cadence from its first claim', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        await queue.createQueue('early');
        await queue.createQueue('done', { deleteAfterSeconds: 1 });
        await queue.createQueue('beats', { heartbeatSeconds: 10 });
        await queue.send('early', null, { id: id(1), expireInSeconds: 1 });
        await queue.send('early', null, { id: id(2), expireInSeconds: 900 });
        await queue.send('done', null, { id: id(3) });
        // Claimed by the 1 s poll at 1000, so its heartbeat is first overdue
        // at 12000, a pass that claims only the late queue.
        await queue.send('beats', null, { id: id(4), startAfter: 1 });
        const held = holding(clock);
        await queue.work('early', { batchSize: 2 }, held.handler);
        await queue.work('done', async () => 'ok');
        await queue.work(
          'beats',
          { pollingIntervalSeconds: 1, heartbeatRefreshSeconds: 60 },
          held.handler,
        );
        try {
          await flush(clock);
          await clock.tick(1500);
          await queue.createQueue('late');
          const states = [];
          for (const step of [500, 1000, 9000, 1000]) {
            await clock.tick(step);
            states.push({
              at: clock.now() - origin,
              early: (await read(queue, 'early', 1))?.state,
              done: (await read(queue, 'done', 3))?.state ?? 'deleted',
              beats: (await read(queue, 'beats', 4))?.state,
            });
          }
          return { states, errors: errors.map((error) => error.message) };
        } finally {
          held.release();
        }
      },
      {
        ...supervised,
        monitorIntervalSeconds: 2,
        maintenanceIntervalSeconds: 2,
      },
    );

    assert.deepStrictEqual(observed, {
      states: [
        { at: 2000, early: 'active', done: 'completed', beats: 'active' },
        { at: 3000, early: 'retry', done: 'deleted', beats: 'active' },
        { at: 12000, early: 'retry', done: 'deleted', beats: 'active' },
        { at: 13000, early: 'retry', done: 'deleted', beats: 'retry' },
      ],
      errors: [],
    });
  });

  it('deletes settled jobs past deleteAfterSeconds and queued ones past keepUntil, never active ones', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        await queue.createQueue('jobs', {
          deleteAfterSeconds: 2,
          retryLimit: 0,
        });
        await queue.createQueue('idle', { retentionSeconds: 2 });
        await queue.createQueue('keep', { deleteAfterSeconds: 0 });
        await queue.createQueue('held', { retentionSeconds: 2 });
        await queue.send('idle', null, { id: id(10) });
        await queue.send('idle', null, { id: id(11), startAfter: 60 });
        await queue.send('idle', null, { id: id(12) });
        await queue.send('jobs', null, { id: id(1) });
        await queue.send('jobs', null, { id: id(2) });
        await queue.send('jobs', null, { id: id(3) });
        await queue.send('keep', null, { id: id(4) });
        await queue.send('held', null, { id: id(5) });
        await queue.cancel('jobs', id(2));
        // A job that never ran fails into retry while attempts remain, else
        // for good (plans.js:2433-2439), keeping its keep_until.
        await queue.fail('jobs', id(3));
        await queue.fail('idle', id(12));
        await queue.work('jobs', async () => 'ok');
        await queue.work('keep', async () => 'ok');
        const held = holding(clock);
        await queue.work('held', held.handler);
        try {
          await flush(clock);
          const list = async (name: string) =>
            (await queue.findJobs(name)).map((job) => {
              const observed = Observe.job(job);
              return `${observed.id}:${observed.state}:${observed.completedOn}:${observed.keepUntil}`;
            });
          const seen = [];
          for (let second = 0; second < 4; second++) {
            await clock.tick(1000);
            seen.push({
              at: clock.now() - origin,
              jobs: await list('jobs'),
              idle: await list('idle'),
              keep: await list('keep'),
              held: await list('held'),
            });
          }
          return { seen, errors: errors.map((error) => error.message) };
        } finally {
          held.release();
        }
      },
      supervised,
    );

    // deletion (plans.js:3055-3066): completed_on + deletion_seconds < now
    // when deletion_seconds > 0, and keep_until < now for created and retry
    // jobs; both strict, active jobs never.
    const jobs = [
      `${id(1)}:completed:0:${retention}`,
      `${id(2)}:cancelled:0:${retention}`,
      `${id(3)}:failed:0:${retention}`,
    ];
    const idle = [
      `${id(10)}:created:null:2000`,
      `${id(11)}:created:null:62000`,
      `${id(12)}:retry:null:2000`,
    ];
    const keep = [`${id(4)}:completed:0:${retention}`];
    const held = [`${id(5)}:active:null:2000`];
    const kept = { jobs: [], idle: [idle[1]], keep, held };
    assert.deepStrictEqual(observed, {
      seen: [
        { at: 1000, jobs, idle, keep, held },
        { at: 2000, jobs, idle, keep, held },
        { at: 3000, ...kept },
        { at: 4000, ...kept },
      ],
      errors: [],
    });
  });

  it('maintains each queue once per maintenanceIntervalSeconds, a day by default', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        await queue.createQueue('jobs', { deleteAfterSeconds: 1 });
        await queue.send('jobs', null, { id: id(1) });
        await queue.work('jobs', async () => 'ok');
        await flush(clock);
        const states = async () =>
          (await queue.findJobs('jobs')).map((job) => job.state);
        await clock.tick(3000);
        const afterSeconds = await states();
        await clock.setTime(origin + 86_400_000);
        await flush(clock);
        const beforeDay = await states();
        await clock.tick(1000);
        const afterDay = await states();
        return {
          afterSeconds,
          beforeDay,
          afterDay,
          errors: errors.map((error) => error.message),
        };
      },
      {
        supervise: true,
        superviseIntervalSeconds: 1,
        monitorIntervalSeconds: 1,
      },
    );

    // The first pass claims the new queue's maintenance at 1000 (plans.js:
    // 1119-1137); the next claim needs 86400 s on maintain_on.
    assert.deepStrictEqual(observed, {
      afterSeconds: ['completed'],
      beforeDay: ['completed'],
      afterDay: [],
      errors: [],
    });
  });

  // queuedCount > (the queue's warningQueueSize || the instance's || 10000)
  // (boss.js:121, 352-358); data is the stats row (plans.js:3548-3552).
  for (const { label, options, warned } of [
    {
      label: "the queue's or the instance's",
      options: { ...supervised, warningQueueSize: 2 },
      warned: [
        { name: 'alpha', queuedCount: 3, size: 0, threshold: 2 },
        { name: 'zeta', queuedCount: 2, size: 1, threshold: 1 },
      ],
    },
    {
      label: "the queue's or 10000",
      options: supervised,
      warned: [{ name: 'zeta', queuedCount: 2, size: 1, threshold: 1 }],
    },
  ]) {
    it(`warns on every pass about each queue whose backlog exceeds ${label}`, async () => {
      const observed = await Parity.assertSame(
        async ({ queue, clock, warnings, errors }) => {
          await queue.start();
          await queue.createQueue('zeta', { warningQueueSize: 1 });
          await queue.createQueue('alpha');
          await queue.createQueue('quiet');
          // A null keeps the stored size (plans.js:1168); the contract types
          // no null.
          await queue.updateQueue(
            'zeta',
            JSON.parse('{"warningQueueSize":null}'),
          );
          for (const n of [1, 2]) {
            await queue.send('zeta', null, { id: id(n) });
          }
          for (const n of [3, 4, 5]) {
            await queue.send('alpha', null, { id: id(n) });
          }
          for (const n of [6, 7]) {
            await queue.send('quiet', null, { id: id(n) });
          }
          await clock.tick(2000);
          // A pass emits in its stats statement's row order, which pg-boss
          // leaves to the planner (plans.js:1181-1220, 3538-3557): on PGlite,
          // name order for a few queues and creation order from 12.
          return {
            warnings: warnings.toSorted(
              (a, b) => a.at - b.at || a.message.localeCompare(b.message),
            ),
            errors: errors.map((error) => error.message),
          };
        },
        options,
      );

      const pass = (at: number) =>
        warned.map(({ name, queuedCount, size, threshold }) => ({
          at,
          message: `Warning: large queue backlog: queue "${name}" has ${queuedCount} jobs in the created or retry state, over its warning threshold of ${threshold}. Your queue should be reviewed`,
          data: {
            name,
            queuedCount,
            warningQueueSize: size,
            pinSeconds: true,
          },
        }));
      assert.deepStrictEqual(observed, {
        warnings: [...pass(1000), ...pass(2000)],
        errors: [],
      });
    });
  }

  // Worker A holds job 1; worker B, polling every 500 ms, faces jobs 2 and 3.
  // A singleton or stately batch mixing a free key with a held one is
  // refused whole (plans.js:2026), as is a one-job fetch of a held key; the
  // monitor's singletonsActive, once the cache holds it, keeps the active
  // keys out of every fetch (plans.js:1941, 3462; manager.js:1564-1572).
  const defaultCache = {
    supervise: true,
    superviseIntervalSeconds: 1,
    monitorIntervalSeconds: 1,
  } satisfies RunOptions;
  const heldKeyCases: {
    label: string;
    options: RunOptions;
    claims: { at: number; ids: string[] }[];
    policy?: 'singleton' | 'stately' | 'standard';
    // null sends job 1 without a key.
    held?: string | null;
    queued?: [number, string | undefined][];
    batchSize?: number;
    sendAt?: number;
    at1500?: (queue: JobQueue) => Promise<unknown>;
  }[] = [
    { label: 'never without supervision', options: {}, claims: [] },
    {
      label: 'at the first cache refresh after a pass',
      options: supervised,
      claims: [{ at: 2000, ids: [id(3)] }],
    },
    {
      label: 'on the slower cache cadence',
      options: {
        supervise: true,
        superviseIntervalSeconds: 5,
        monitorIntervalSeconds: 5,
        queueCacheIntervalSeconds: 3,
      },
      claims: [{ at: 6000, ids: [id(3)] }],
    },
    {
      label: 'on a stately queue',
      policy: 'stately',
      options: supervised,
      claims: [{ at: 2000, ids: [id(3)] }],
    },
    {
      label: 'one job at a time',
      batchSize: 1,
      options: supervised,
      claims: [{ at: 2000, ids: [id(3)] }],
    },
    {
      label: 'when the held job has no key',
      held: null,
      queued: [
        [2, undefined],
        [3, 'k2'],
      ],
      options: supervised,
      claims: [{ at: 2000, ids: [id(3)] }],
    },
    {
      label: 'to a job with no key',
      queued: [
        [2, undefined],
        [3, 'k1'],
      ],
      options: supervised,
      claims: [{ at: 2000, ids: [id(2)] }],
    },
    {
      label: 'only on singleton and stately queues',
      policy: 'standard',
      queued: [[2, 'k1']],
      batchSize: 1,
      sendAt: 2000,
      options: supervised,
      claims: [{ at: 2000, ids: [id(2)] }],
    },
    {
      label: 'not before the 60 s cache refresh',
      options: defaultCache,
      claims: [],
    },
    {
      label: 'once updateQueue evicts the cached queue',
      options: defaultCache,
      at1500: (queue) => queue.updateQueue('jobs', { retryLimit: 1 }),
      claims: [{ at: 2000, ids: [id(3)] }],
    },
    {
      label: 'once createQueue evicts the cached queue',
      options: defaultCache,
      at1500: (queue) => queue.createQueue('jobs', { policy: 'singleton' }),
      claims: [{ at: 2000, ids: [id(3)] }],
    },
  ];
  const twoKeys: [number, string | undefined][] = [
    [2, 'k1'],
    [3, 'k2'],
  ];
  for (const {
    label,
    options,
    claims,
    policy = 'singleton',
    held: heldKey = 'k1',
    queued = twoKeys,
    batchSize = 2,
    sendAt = 0,
    at1500,
  } of heldKeyCases) {
    it(`lets a batch past a held singleton key ${label}`, async () => {
      const observed = await Parity.assertSame(
        async ({ queue, clock, wip, errors }) => {
          await queue.start();
          await queue.createQueue('jobs', { policy });
          // null sends without a key.
          await queue.send(
            'jobs',
            null,
            keyed({ id: id(1) }, heldKey ?? undefined),
          );
          const held = holding(clock);
          await queue.work('jobs', held.handler);
          const sendQueued = async () => {
            for (const [n, singletonKey] of queued) {
              await queue.send(
                'jobs',
                null,
                keyed({ id: id(n) }, singletonKey),
              );
            }
            await queue.work(
              'jobs',
              { batchSize, pollingIntervalSeconds: 0.5 },
              held.handler,
            );
          };
          try {
            await flush(clock);
            if (sendAt === 0) {
              await sendQueued();
            }
            for (let step = 1; step <= 12; step++) {
              await clock.tick(500);
              if (step === 3 && at1500) {
                await at1500(queue);
              }
              if (step * 500 === sendAt) {
                await sendQueued();
              }
            }
            return {
              batches: [...held.batches],
              // When each worker last fetched, as the wip event at 6000
              // lists them: B kept polling even where it claimed nothing.
              fetched: wip.at(-1)?.workers.map((w) => w.lastFetchedOn),
              errors: errors.map((error) => error.message),
            };
          } finally {
            held.release();
          }
        },
        options,
      );

      assert.deepStrictEqual(observed, {
        batches: [{ at: 0, ids: [id(1)] }, ...claims],
        // B's last poll, or the batch it still holds; the wip interval at
        // 6000 fires before B's poll at 6000 (armed earlier on the clock).
        fetched: [0, Math.min(claims.at(-1)?.at ?? 5500, 5500)],
        errors: [],
      });
    });
  }

  // Each start loads every queue into the cache (manager.js:837), so a
  // restarted queue fetches with the keys its last pass found active, here
  // job 1's, which the restart's failWip has since put back in retry.
  it('loads the queue cache at every start', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        await queue.createQueue('jobs', { policy: 'singleton' });
        await queue.send('jobs', null, { id: id(1), singletonKey: 'k1' });
        const held = holding(clock);
        await queue.work('jobs', held.handler);
        try {
          await flush(clock);
          await clock.tick(1000);
          await queue.stop({ graceful: false, close: false });
          await queue.start();
          await queue.send('jobs', null, { id: id(2), singletonKey: 'k2' });
          await queue.work('jobs', { batchSize: 2 }, held.handler);
          await flush(clock);
          return {
            batches: [...held.batches],
            states: (await queue.findJobs('jobs')).map((job) => job.state),
            errors: errors.map((error) => error.message),
          };
        } finally {
          held.release();
        }
      },
      {
        supervise: true,
        superviseIntervalSeconds: 1,
        monitorIntervalSeconds: 1,
      },
    );

    assert.deepStrictEqual(observed, {
      batches: [
        { at: 0, ids: [id(1)] },
        { at: 1000, ids: [id(2)] },
      ],
      states: ['retry', 'active'],
      errors: [],
    });
  });

  // Boss.stop stops the claim timer and start arms a new one an interval out
  // (boss.js:128-148), so a restart at 1500 moves the next pass from 2000 to
  // 2500.
  it('re-arms the supervisor from a restart', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        await queue.createQueue('jobs', { deleteAfterSeconds: 1 });
        await queue.send('jobs', null, { id: id(1) });
        await queue.work('jobs', async () => 'ok');
        await clock.tick(1500);
        await queue.stop({ graceful: false, close: false });
        await queue.start();
        const states = async () =>
          (await queue.findJobs('jobs')).map((job) => job.state);
        await clock.tick(500);
        const at2000 = await states();
        await clock.tick(500);
        return {
          at2000,
          at2500: await states(),
          errors: errors.map((error) => error.message),
        };
      },
      supervised,
    );

    assert.deepStrictEqual(observed, {
      at2000: ['completed'],
      at2500: [],
      errors: [],
    });
  });

  // stop clears the cache interval (manager.js:866-869), so after a restart
  // at 1500 the cache refreshes at 2500 and 3500 only: the key the pass at
  // 2500 finds held reaches worker B at 3500.
  it('refreshes the cache on the restarted interval only', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        await queue.createQueue('jobs', { policy: 'singleton' });
        await clock.tick(1500);
        await queue.stop({ graceful: false, close: false });
        await queue.start();
        await queue.send('jobs', null, { id: id(1), singletonKey: 'k1' });
        const held = holding(clock);
        await queue.work('jobs', held.handler);
        try {
          await flush(clock);
          await queue.send('jobs', null, { id: id(2), singletonKey: 'k1' });
          await queue.send('jobs', null, { id: id(3), singletonKey: 'k2' });
          await queue.work(
            'jobs',
            { batchSize: 2, pollingIntervalSeconds: 0.5 },
            held.handler,
          );
          for (let step = 0; step < 5; step++) {
            await clock.tick(500);
          }
          return {
            batches: [...held.batches],
            errors: errors.map((error) => error.message),
          };
        } finally {
          held.release();
        }
      },
      supervised,
    );

    assert.deepStrictEqual(observed, {
      batches: [
        { at: 1500, ids: [id(1)] },
        { at: 3500, ids: [id(3)] },
      ],
      errors: [],
    });
  });

  // A full fetch bursts while the cached readyCount exceeds the threshold
  // (manager.js:931-947). The pass at 1000 counts 3 ready; the cache reads
  // that at 2000, after the poll that claims job 2, and before the next.
  for (const { label, options, at } of [
    {
      label: 'polls every 2 s without supervision',
      options: {},
      at: [0, 2000, 4000, 6000, 8000],
    },
    {
      label: 'bursts once the cached ready count exceeds the threshold',
      options: supervised,
      at: [0, 2000, 4000, 4000, 4000],
    },
  ]) {
    it(`burstWhenReadyExceeds ${label}`, async () => {
      const observed = await Parity.assertSame(
        async ({ queue, clock, errors }) => {
          await queue.start();
          await queue.createQueue('jobs');
          for (const n of [1, 2, 3, 4, 5]) {
            await queue.send('jobs', null, { id: id(n) });
          }
          const claims: { at: number; ids: string[] }[] = [];
          await queue.work(
            'jobs',
            { burstWhenReadyExceeds: 1 },
            async (jobs) => {
              claims.push({
                at: clock.now() - origin,
                ids: jobs.map((job) => job.id),
              });
            },
          );
          for (let step = 0; step < 10; step++) {
            await clock.tick(1000);
          }
          return {
            claims: [...claims],
            errors: errors.map((error) => error.message),
          };
        },
        options,
      );

      assert.deepStrictEqual(observed, {
        claims: at.map((time, index) => ({ at: time, ids: [id(index + 1)] })),
        errors: [],
      });
    });
  }

  it('burstWhenReadyExceeds counts ready jobs without the deferred ones', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        const claims: Record<'a' | 'b', number[]> = { a: [], b: [] };
        for (const [name, threshold] of [
          ['a', 2],
          ['b', 3],
        ] as const) {
          await queue.createQueue(name);
          for (const n of [1, 2, 3, 4]) {
            await queue.send(name, null, { id: id(n) });
          }
          for (const n of [5, 6, 7]) {
            await queue.send(name, null, { id: id(n), startAfter: 60 });
          }
          await queue.send(name, null, { id: id(8), startAfter: 2 });
          await queue.work(
            name,
            { burstWhenReadyExceeds: threshold },
            async () => {
              claims[name].push(clock.now() - origin);
            },
          );
        }
        for (let step = 0; step < 8; step++) {
          await clock.tick(1000);
        }
        return {
          claims: structuredClone(claims),
          errors: errors.map((error) => error.message),
        };
      },
      supervised,
    );

    // The poll at 4000 reads the pass at 2000 through the cache at 3000:
    // six queued, three deferred, and job 8, due at 2000 exactly, ready
    // (start_after > now, plans.js:3449, 3457).
    assert.deepStrictEqual(observed, {
      claims: {
        a: [0, 2000, 4000, 4000, 4000],
        b: [0, 2000, 4000, 6000, 8000],
      },
      errors: [],
    });
  });

  // pg-boss's defaults (attorney.js:610-619): a pass, a monitor claim and a
  // cache refresh every 60 s.
  it('supervises on the default intervals', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, warnings, errors }) => {
        await queue.start();
        await queue.createQueue('jobs', {
          retryLimit: 1,
          retryDelay: 600,
          warningQueueSize: 1,
        });
        await queue.send('jobs', null, { id: id(1), expireInSeconds: 1 });
        await queue.send('jobs', null, { id: id(2), expireInSeconds: 900 });
        for (const n of [3, 4]) {
          await queue.send('jobs', null, { id: id(n), startAfter: 100 });
        }
        await queue.createQueue('burst');
        for (const n of [5, 6, 7, 8, 9, 10]) {
          await queue.send('burst', null, { id: id(n) });
        }
        const claims: number[] = [];
        await queue.work(
          'burst',
          { burstWhenReadyExceeds: 1, pollingIntervalSeconds: 30 },
          async () => {
            claims.push(clock.now() - origin);
          },
        );
        const held = holding(clock);
        await queue.work('jobs', { batchSize: 2 }, held.handler);
        try {
          const seen = [];
          for (const step of [59999, 1, 59999, 1, 60000]) {
            await clock.tick(step);
            seen.push({
              at: clock.now() - origin,
              state: (await read(queue, 'jobs', 1))?.state,
              warnings: warnings.length,
            });
          }
          return {
            seen,
            claims: [...claims],
            errors: errors.map((error) => error.message),
          };
        } finally {
          held.release();
        }
      },
      { supervise: true },
    );

    // The pass at 60000 expires job 1 and counts 4 ready burst jobs, which
    // the cache reads at 120000, just before the poll that then drains them.
    assert.deepStrictEqual(observed, {
      seen: [
        { at: 59999, state: 'active', warnings: 0 },
        { at: 60000, state: 'retry', warnings: 1 },
        { at: 119999, state: 'retry', warnings: 1 },
        { at: 120000, state: 'retry', warnings: 2 },
        { at: 180000, state: 'retry', warnings: 3 },
      ],
      claims: [0, 30000, 60000, 90000, 120000, 120000],
      errors: [],
    });
  });

  // A failed pass emits its error as is (boss.js:193-195) and a failed cache
  // refresh a spread copy (manager.js:842-847); the claim timer re-arms after
  // the failed pass (claimTimer.js:110-118), and the cache keeps what it held.
  // Renaming singletons_active faults both on both backends (pg-boss's
  // getQueues and SQLite's stats write read it) while no lookup runs.
  it('reports a failed pass and cache refresh, then supervises on', async () => {
    const rename = (backend: string, from: string, to: string) =>
      `ALTER TABLE ${backend === 'pg-boss' ? 'pgboss.queue' : 'pgboss_queue'} RENAME COLUMN ${from} TO ${to}`;
    const observed = await Parity.assertSame(
      async ({ queue, clock, warnings, errors, backend, sql }) => {
        await queue.start();
        await queue.createQueue('jobs', {
          policy: 'singleton',
          warningQueueSize: 1,
        });
        await queue.send('jobs', null, { id: id(1), singletonKey: 'k1' });
        const held = holding(clock);
        await queue.work('jobs', held.handler);
        try {
          await flush(clock);
          await queue.send('jobs', null, { id: id(2), singletonKey: 'k1' });
          await queue.send('jobs', null, { id: id(3), singletonKey: 'k2' });
          // The pass at 1000 records k1 active after the cache read none.
          await clock.tick(1000);
          await sql(rename(backend, 'singletons_active', 'singletons_hidden'));
          await clock.tick(1000);
          await sql(rename(backend, 'singletons_hidden', 'singletons_active'));
          // Worker B fetches with the cache the failed refresh kept, so k1
          // is not skipped and the batch with it is refused.
          await queue.work('jobs', { batchSize: 2 }, held.handler);
          await flush(clock);
          const batches = [...held.batches];
          await clock.tick(1000);
          return {
            batches,
            warnings: warnings.map((warning) => warning.at),
            errors: errors.map((error) => error instanceof Error),
          };
        } finally {
          held.release();
        }
      },
      supervised,
    );

    assert.deepStrictEqual(observed, {
      batches: [{ at: 0, ids: [id(1)] }],
      warnings: [1000, 3000],
      errors: [false, true],
    });
  });

  it('validates the supervisor options in pg-boss order, when built', async () => {
    // Plain objects, so values the option types exclude reach both.
    const cases: object[] = [
      { superviseIntervalSeconds: 0 },
      { superviseIntervalSeconds: 86_401 },
      { superviseIntervalSeconds: undefined },
      { maintenanceIntervalSeconds: 0.5 },
      { maintenanceIntervalSeconds: 86_400.5 },
      { monitorIntervalSeconds: 0 },
      { monitorIntervalSeconds: 90_000 },
      { queueCacheIntervalSeconds: -1 },
      { queueCacheIntervalSeconds: 100_000 },
      { warningQueueSize: 0 },
      { warningQueueSize: 0, queueCacheIntervalSeconds: 0 },
      { queueCacheIntervalSeconds: 0, monitorIntervalSeconds: 0 },
      { monitorIntervalSeconds: 0, maintenanceIntervalSeconds: 0 },
      { maintenanceIntervalSeconds: 0, superviseIntervalSeconds: 0 },
      { supervise: false, superviseIntervalSeconds: 0 },
      { superviseIntervalSeconds: Number.NaN },
      { monitorIntervalSeconds: null },
      { queueCacheIntervalSeconds: Number.POSITIVE_INFINITY },
      { warningQueueSize: -1 },
      { warningQueueSize: null },
      { warningQueueSize: undefined },
      { warningQueueSize: 0.5 },
      { maintenanceIntervalSeconds: '5' },
      { superviseIntervalSeconds: 1.5, warningQueueSize: 1.5 },
      { supervise: 'yes' },
      {
        superviseIntervalSeconds: 86_400,
        maintenanceIntervalSeconds: 1,
        monitorIntervalSeconds: 86_400,
        queueCacheIntervalSeconds: 1,
        warningQueueSize: 1,
      },
    ];
    const outcome = (build: () => unknown) => {
      try {
        build();
        return 'built';
      } catch (error) {
        return error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      }
    };
    // Neither is started: pg-boss validates in its constructor
    // (index.js:65, attorney.js:407-426), before it touches its database.
    const pglite = new PGlite();
    const database = new DatabaseSync(':memory:');
    let pgBoss;
    let sqlite;
    try {
      pgBoss = cases.map((options) =>
        outcome(
          () =>
            new PgBoss({
              backend: 'pglite',
              db: fromPglite(pglite),
              ...options,
            }),
        ),
      );
      sqlite = cases.map((options) =>
        outcome(() => new SqliteJobQueue({ database, ...options })),
      );
    } finally {
      database.close();
      await pglite.close();
    }

    assert.deepStrictEqual(sqlite, pgBoss);
    const failed = (message: string) =>
      `AssertionError: configuration assert: ${message}`;
    assert.deepStrictEqual(pgBoss, [
      failed('superviseIntervalSeconds must be at least every second'),
      failed('superviseIntervalSeconds cannot exceed 24 hours'),
      failed('superviseIntervalSeconds must be at least every second'),
      failed('maintenanceIntervalSeconds must be at least every second'),
      failed('maintenanceIntervalSeconds cannot exceed 24 hours'),
      failed('monitorIntervalSeconds must be at least every second'),
      failed('monitorIntervalSeconds cannot exceed 24 hours'),
      failed('queueCacheIntervalSeconds must be at least every second'),
      failed('queueCacheIntervalSeconds cannot exceed 24 hours'),
      failed('warningQueueSize must be at least 1'),
      failed('queueCacheIntervalSeconds must be at least every second'),
      failed('monitorIntervalSeconds must be at least every second'),
      failed('maintenanceIntervalSeconds must be at least every second'),
      failed('superviseIntervalSeconds must be at least every second'),
      failed('superviseIntervalSeconds must be at least every second'),
      failed('superviseIntervalSeconds must be at least every second'),
      failed('monitorIntervalSeconds must be at least every second'),
      failed('queueCacheIntervalSeconds cannot exceed 24 hours'),
      failed('warningQueueSize must be at least 1'),
      failed('warningQueueSize must be at least 1'),
      failed('warningQueueSize must be at least 1'),
      failed('warningQueueSize must be at least 1'),
      'built',
      'built',
      'built',
      'built',
    ]);
  });
});
