import assert from 'node:assert/strict';
import { describe } from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import {
  type Job,
  PgBoss,
  type SendOptions,
  type TestClock,
  fromPglite,
} from 'pg-boss';

import { it } from '@zukhruf/parameterized-test';
import { open } from '@zukhruf/sqlite-open';

import type { JobQueue } from '../index.ts';
import { SqliteJobQueue } from '../index.ts';
import { flush } from '../testing/flush.ts';
import { id } from '../testing/job-id.ts';
import { supervised } from '../testing/supervised.ts';
import { ParityRun, type RunOptions } from './backends.ts';
import { Observe } from './observe.ts';
import { Parity } from './parity.ts';

// { ...options, singletonKey }: pg-boss reads an undefined key as no key,
// which its types cannot hold under exactOptionalPropertyTypes.
const keyed = (options: SendOptions, singletonKey: string | undefined) => {
  Reflect.set(options, 'singletonKey', singletonKey);
  return options;
};

const origin = Date.parse(ParityRun.start);

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
            reason: Error.isError(reason) ? reason.message : String(reason),
          });
        });
      }
      await release.promise;
    },
  };
}

// An expireInSeconds 1 job batched with a 900 s one: the batch's deadline is
// the larger expiry, so only the supervisor can expire the short job
// (node_modules/pg-boss/dist/manager.js:603-618).
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
    // (plans.js:3106-3110, 3117-3120), through failJobsBody's retry branch unfenced
    // (3193-3208). The handler keeps running; its completion is fenced out
    // and its signals abort only when the batch settles.
    const retried = {
      ...active,
      state: 'retry',
      startAfter: 62000,
      output: timedOut,
      heartbeatOn: null,
      // The retention window moves with the start (12.38.2, #994:
      // plans.js:3268).
      keepUntil: 62000 + retention,
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
    // job with its output as source_output (plans.js:3196-3202, 3384-3413).
    const failed = {
      ...active,
      state: 'failed',
      completedOn: 2000,
      output: timedOut,
      heartbeatOn: null,
    };
    assert.deepStrictEqual(observed.timeline.at(-1), { at: 2000, job: failed });
    // The handler's completion at 3000 is fenced out (plans.js:2642-2645).
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

  // pg-boss reads the key's presence (attorney.js:416); an explicit
  // undefined is outside its types under exactOptionalPropertyTypes.
  const supervisedUndefined: RunOptions = { ...supervised };
  Reflect.set(supervisedUndefined, 'supervise', undefined);
  void it.each(
    [
      {
        label: 'supervise: false',
        options: { ...supervised, supervise: false },
      },
      { label: 'supervise: undefined', options: supervisedUndefined },
    ],
    ({ label, options }) =>
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
      }),
  );

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
    // (plans.js:3111-3116, 3121-3124); the worker's next touch finds the claim gone
    // (manager.js:620-649).
    const retried = {
      ...active,
      state: 'retry',
      startAfter: 611000,
      output: { value: { message: 'job heartbeat timeout' } },
      heartbeatOn: null,
      keepUntil: 611000 + retention,
    };
    const lost = {
      id: id(1),
      at: 60000,
      reason: `job ${id(1)} is no longer active under this worker's claim`,
    };
    // Expiry runs first in a pass (boss.js:400-408), so a job past both
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
  // 1360-1377, 1529-1547, 2968-2975, 3690-3696).
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
        // for good (plans.js:3196-3202), keeping its keep_until.
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

    // deletion (plans.js:3839-3846): completed_on + deletion_seconds < now
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
    // 1529-1547); the next claim needs 86400 s on maintain_on.
    assert.deepStrictEqual(observed, {
      afterSeconds: ['completed'],
      beforeDay: ['completed'],
      afterDay: [],
      errors: [],
    });
  });

  // queuedCount > (the queue's warningQueueSize || the instance's || 10000)
  // (boss.js:140, 388-394); data is the stats row (plans.js:4621-4625).
  void it.each(
    [
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
    ],
    ({ label, options, warned }) =>
      it(`warns on every pass about each queue whose backlog exceeds ${label}`, async () => {
        const observed = await Parity.assertSame(
          async ({ queue, clock, warnings, errors }) => {
            await queue.start();
            await queue.createQueue('zeta', { warningQueueSize: 1 });
            await queue.createQueue('alpha');
            await queue.createQueue('quiet');
            // A null keeps the stored size (plans.js:1597); the contract types
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
            // A pass emits in its stats statement's RETURNING order, which
            // has no ORDER BY, so pg-boss leaves it to the planner
            // (plans.js:4611-4630).
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
      }),
  );

  // Worker A holds job 1; worker B, polling every 500 ms, faces jobs 2 and 3.
  // A singleton or stately fetch skips a key whose job is active, read live,
  // so B's first poll claims the free key whatever the monitor last counted
  // or the cache holds (12.37.1, #957: plans.js:2520-2532; manager.js:2088).
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
  }[] = [
    {
      label: 'without supervision',
      options: {},
      claims: [{ at: 0, ids: [id(3)] }],
    },
    {
      label: 'before any pass',
      options: supervised,
      claims: [{ at: 0, ids: [id(3)] }],
    },
    {
      label: 'on a slow cache cadence',
      options: {
        supervise: true,
        superviseIntervalSeconds: 5,
        monitorIntervalSeconds: 5,
        queueCacheIntervalSeconds: 3,
      },
      claims: [{ at: 0, ids: [id(3)] }],
    },
    {
      label: 'before the 60 s cache refresh',
      options: {
        supervise: true,
        superviseIntervalSeconds: 1,
        monitorIntervalSeconds: 1,
      },
      claims: [{ at: 0, ids: [id(3)] }],
    },
    {
      label: 'on a stately queue',
      policy: 'stately',
      options: supervised,
      claims: [{ at: 0, ids: [id(3)] }],
    },
    {
      label: 'one job at a time',
      batchSize: 1,
      options: supervised,
      claims: [{ at: 0, ids: [id(3)] }],
    },
    {
      label: 'when the held job has no key',
      held: null,
      queued: [
        [2, undefined],
        [3, 'k2'],
      ],
      options: supervised,
      claims: [{ at: 0, ids: [id(3)] }],
    },
    {
      label: 'to a job with no key',
      queued: [
        [2, undefined],
        [3, 'k1'],
      ],
      options: supervised,
      claims: [{ at: 0, ids: [id(2)] }],
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
  ];
  const twoKeys: [number, string | undefined][] = [
    [2, 'k1'],
    [3, 'k2'],
  ];
  void it.each(
    heldKeyCases,
    ({
      label,
      options,
      claims,
      policy = 'singleton',
      held: heldKey = 'k1',
      queued = twoKeys,
      batchSize = 2,
      sendAt = 0,
    }) =>
      it(`skips a held singleton key at once ${label}`, async () => {
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
                if (step * 500 === sendAt) {
                  await sendQueued();
                }
              }
              return {
                batches: [...held.batches],
                // When each worker last fetched, as the wip event at 6000
                // lists them.
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
          // B holds the batch it claimed, so its last fetch is that claim.
          fetched: [0, claims.at(-1)?.at],
          errors: [],
        });
      }),
  );

  // Each start loads every queue into the cache (manager.js:1057), and a
  // full fetch bursts while the cached readyCount exceeds the threshold
  // (manager.js:1207-1222). The pass at 1000 counts jobs 2 to 5 ready, so the
  // restart at 1000 bursts on that count, 59 s before the cache refreshes.
  it('loads the queue cache at every start', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        await queue.createQueue('jobs');
        for (const n of [1, 2, 3, 4, 5]) {
          await queue.send('jobs', null, { id: id(n) });
        }
        const claims: { at: number; ids: string[] }[] = [];
        const claim = async (jobs: { id: string }[]) => {
          claims.push({
            at: clock.now() - origin,
            ids: jobs.map((job) => job.id),
          });
        };
        await queue.work('jobs', { burstWhenReadyExceeds: 1 }, claim);
        await clock.tick(1000);
        await queue.stop({ graceful: false, close: false });
        await queue.start();
        await queue.work('jobs', { burstWhenReadyExceeds: 1 }, claim);
        await flush(clock);
        return {
          claims: [...claims],
          errors: errors.map((error) => error.message),
        };
      },
      {
        supervise: true,
        superviseIntervalSeconds: 1,
        monitorIntervalSeconds: 1,
      },
    );

    assert.deepStrictEqual(observed, {
      claims: [0, 1000, 1000, 1000, 1000].map((at, index) => ({
        at,
        ids: [id(index + 1)],
      })),
      errors: [],
    });
  });

  // Boss.stop stops the claim timer and start arms a new one an interval out
  // (boss.js:147-167), so a restart at 1500 moves the next pass from 2000 to
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

  // stop clears the cache interval (manager.js:1128), so after a restart at
  // 1500 the cache refreshes at 2500 and 3500 only, each ahead of the pass
  // due with it (armed first at start). The ready count the pass at 2500
  // writes makes the full fetch at 3500 burst (manager.js:1207-1222).
  it('refreshes the cache on the restarted interval only', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, errors }) => {
        await queue.start();
        await queue.createQueue('jobs');
        await clock.tick(1500);
        await queue.stop({ graceful: false, close: false });
        await queue.start();
        for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) {
          await queue.send('jobs', null, { id: id(n) });
        }
        const claims: { at: number; ids: string[] }[] = [];
        await queue.work(
          'jobs',
          { burstWhenReadyExceeds: 1, pollingIntervalSeconds: 0.5 },
          async (jobs) => {
            claims.push({
              at: clock.now() - origin,
              ids: jobs.map((job) => job.id),
            });
          },
        );
        for (let step = 0; step < 5; step++) {
          await clock.tick(500);
        }
        return {
          claims: [...claims],
          errors: errors.map((error) => error.message),
        };
      },
      supervised,
    );

    assert.deepStrictEqual(observed, {
      claims: [1500, 2000, 2500, 3000, 3500, 3500, 3500, 3500].map(
        (at, index) => ({ at, ids: [id(index + 1)] }),
      ),
      errors: [],
    });
  });

  // A full fetch bursts while the cached readyCount exceeds the threshold
  // (manager.js:1207-1223). The pass at 1000 counts 3 ready; the cache reads
  // that at 2000, after the poll that claims job 2, and before the next.
  void it.each(
    [
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
    ],
    ({ label, options, at }) =>
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
      }),
  );

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
    // (start_after > now, plans.js:4374-4375).
    assert.deepStrictEqual(observed, {
      claims: {
        a: [0, 2000, 4000, 4000, 4000],
        b: [0, 2000, 4000, 6000, 8000],
      },
      errors: [],
    });
  });

  // pg-boss's defaults (attorney.js:664-673): a pass, a monitor claim and a
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

  // A failed pass emits its error as is (boss.js:212-214) and a failed cache
  // refresh a spread copy (manager.js:1056-1058); the claim timer re-arms
  // after the failed pass (claimTimer.js:110-118). Renaming singletons_active
  // faults both on both backends (pg-boss's getQueues and SQLite's stats
  // write read it) while no lookup runs.
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
          // Jobs 2 and 3 wait, over warningQueueSize: each pass that runs
          // warns.
          await clock.tick(1000);
          await sql(rename(backend, 'singletons_active', 'singletons_hidden'));
          await clock.tick(1000);
          await sql(rename(backend, 'singletons_hidden', 'singletons_active'));
          const batches = [...held.batches];
          await clock.tick(1000);
          return {
            batches,
            warnings: warnings.map((warning) => warning.at),
            errors: errors.map((error) => Error.isError(error)),
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
        return Error.isError(error)
          ? `${error.name}: ${error.message}`
          : String(error);
      }
    };
    // Neither is started: pg-boss validates in its constructor
    // (index.js:82, attorney.js:410-431), before it touches its database.
    const pglite = new PGlite();
    const database = open(':memory:');
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
