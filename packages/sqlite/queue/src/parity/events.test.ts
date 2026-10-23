import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { type Job, PgBoss, TestClock, fromPglite } from 'pg-boss';

import { SqliteJobQueue } from '../index.ts';
import { ParityRun, type WipWorker } from './backends.ts';
import { Parity } from './parity.ts';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

// A handler that records each batch and holds every batch until released.
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

// A TestClock that refuses to attach, so start() throws once it has begun.
class RefusingClock extends TestClock {
  override async attach(): Promise<AsyncDisposable> {
    throw new Error('attach refused');
  }
}

// A worker's wip entry: the first worker of a default work() on `jobs` that
// fetched once at the clock's start, with the fields a scenario changes.
function worker(fields: Partial<WipWorker>): WipWorker {
  return {
    id: 'w1',
    workId: 'w1',
    name: 'jobs',
    options: { pollingInterval: 2000, notifyPollingInterval: 30000 },
    state: 'active',
    count: 0,
    createdOn: 0,
    lastFetchedOn: 0,
    lastJobStartedOn: 0,
    lastJobEndedOn: null,
    lastError: null,
    lastErrorOn: null,
    lastJobDuration: null,
    ...fields,
  };
}

describe('wip events', () => {
  it('list the workers every 2s while one holds a batch', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock, wip }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', null, { id: id(1) });
      const held = holding();
      await queue.work('jobs', held.handler);
      try {
        await clock.tick(4000);
        held.release();
        await clock.tick(4000);
        return { batches: [...held.batches], wip: [...wip] };
      } finally {
        held.release();
      }
    });

    // The 2s interval emits once 2000 ms have passed since the last wip and
    // a worker holds jobs (node_modules/pg-boss/dist/manager.js:826-836).
    const holder = worker({ count: 1 });
    assert.deepStrictEqual(observed, {
      batches: [[id(1)]],
      wip: [
        { at: 2000, workers: [holder] },
        { at: 4000, workers: [holder] },
      ],
    });
  });

  it('list nothing while every worker is idle, which leaves the 2s window open', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock, wip }) => {
      await queue.start();
      await queue.createQueue('jobs');
      await queue.createQueue('other');
      await queue.work('jobs', async () => {});
      await queue.work('other', async () => {});
      await clock.tick(6000);
      const idle = [...wip];
      await queue.send('jobs', null, { id: id(1) });
      await clock.tick(2000);
      return { idle, wip: [...wip] };
    });

    // An empty fetch emits nothing (manager.js:958-962), and an interval
    // with no jobs held keeps the last wip time (832-835), so the claim at
    // 8000 is more than 2000 ms past it and emits before the batch runs.
    assert.deepStrictEqual(observed, {
      idle: [],
      wip: [
        {
          at: 8000,
          workers: [
            worker({
              count: 1,
              lastFetchedOn: 8000,
              lastJobStartedOn: 8000,
              lastJobEndedOn: 6000,
              lastJobDuration: 0,
            }),
            worker({
              id: 'w2',
              workId: 'w2',
              name: 'other',
              lastFetchedOn: 6000,
              lastJobStartedOn: 6000,
              lastJobEndedOn: 6000,
              lastJobDuration: 0,
            }),
          ],
        },
      ],
    });
  });

  for (const { seconds, at } of [
    { seconds: 2, at: [4000, 6000] },
    { seconds: 2.5, at: [2500, 6000] },
  ]) {
    it(`emit before a batch only more than 2000 ms after the last wip (polling every ${seconds}s)`, async () => {
      const observed = await Parity.assertSame(
        async ({ queue, clock, wip }) => {
          await queue.start();
          await queue.createQueue('jobs');
          const held = holding();
          await queue.work(
            'jobs',
            { pollingIntervalSeconds: seconds },
            held.handler,
          );
          await queue.send('jobs', null, { id: id(1) });
          try {
            await clock.tick(6000);
            return wip.map((event) => event.at);
          } finally {
            held.release();
          }
        },
      );

      // Before a batch, strictly more than 2000 ms (manager.js:1067-1074);
      // the interval, 2000 ms or more (826-831).
      assert.deepStrictEqual(observed, at);
    });
  }

  it('emit after a batch with its jobs still counted and the previous end time', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock, wip }) => {
      await queue.start();
      await queue.createQueue('jobs');
      const held = holding();
      await queue.work('jobs', { pollingIntervalSeconds: 2.5 }, held.handler);
      await queue.send('jobs', null, { id: id(1) });
      try {
        await clock.tick(4600);
        held.release();
        await clock.tick(0);
        return [...wip];
      } finally {
        held.release();
      }
    });

    // The emit after a batch (manager.js:990) comes before the worker clears
    // its jobs and stamps the batch's end (worker.js:68-70).
    const holder = worker({
      options: {
        pollingIntervalSeconds: 2.5,
        pollingInterval: 2500,
        notifyPollingInterval: 30000,
      },
      count: 1,
      lastFetchedOn: 2500,
      lastJobStartedOn: 2500,
      lastJobEndedOn: 0,
      lastJobDuration: 0,
    });
    assert.deepStrictEqual(observed, [
      { at: 2500, workers: [holder] },
      { at: 4600, workers: [holder] },
    ]);
  });

  it('count the 2s window from construction, not from start()', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock, wip }) => {
      await clock.tick(3000);
      await queue.start();
      await queue.createQueue('jobs');
      await queue.send('jobs', null, { id: id(1) });
      const held = holding();
      await queue.work('jobs', held.handler);
      try {
        await clock.tick(2000);
        return [...wip];
      } finally {
        held.release();
      }
    });

    // wipTs is read when the manager is built (manager.js:194).
    const holder = worker({
      count: 1,
      createdOn: 3000,
      lastFetchedOn: 3000,
      lastJobStartedOn: 3000,
    });
    assert.deepStrictEqual(observed, [
      { at: 3000, workers: [holder] },
      { at: 5000, workers: [holder] },
    ]);
  });

  it('list every worker not yet stopped, idle and stopping ones included, with its work() options', async () => {
    const observed = await Parity.assertSame(async ({ queue, clock, wip }) => {
      await queue.start();
      for (const name of ['jobs', 'other', 'leaving', 'gone']) {
        await queue.createQueue(name);
      }
      await queue.send('jobs', null, { id: id(1) });
      await queue.send('leaving', null, { id: id(2) });
      const held = holding();
      await queue.work('jobs', { localConcurrency: 2 }, held.handler);
      await queue.work('other', { pollingIntervalSeconds: 5 }, async () => {});
      await queue.work('leaving', held.handler);
      await queue.work('gone', async () => {});
      try {
        await clock.tick(0);
        await queue.offWork('gone');
        await queue.offWork('leaving', { wait: false });
        await clock.tick(2000);
        return [...wip];
      } finally {
        held.release();
      }
    });

    // getWipData lists the workers of every queue but the stopped ones
    // (manager.js:1076-1081); the workers of one work() share its id.
    const concurrent = {
      localConcurrency: 2,
      pollingInterval: 2000,
      notifyPollingInterval: 30000,
    };
    assert.deepStrictEqual(observed, [
      {
        at: 2000,
        workers: [
          worker({ options: concurrent, count: 1 }),
          worker({
            id: 'w2',
            options: concurrent,
            lastJobEndedOn: 0,
            lastJobDuration: 0,
          }),
          worker({
            id: 'w3',
            workId: 'w3',
            name: 'other',
            options: {
              pollingIntervalSeconds: 5,
              pollingInterval: 5000,
              notifyPollingInterval: 30000,
            },
            lastJobEndedOn: 0,
            lastJobDuration: 0,
          }),
          worker({
            id: 'w4',
            workId: 'w4',
            name: 'leaving',
            state: 'stopping',
            count: 1,
          }),
        ],
      },
    ]);
  });

  it("carry a worker's last fetch error and when it happened", async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, wip, errors }) => {
        await queue.start();
        await queue.createQueue('jobs');
        await queue.send('jobs', null, { id: id(1) });
        const held = holding();
        await queue.work('missing', async () => {});
        await queue.work('jobs', held.handler);
        try {
          await clock.tick(4000);
          return { wip: [...wip], errors: errors.length };
        } finally {
          held.release();
        }
      },
    );

    // A failed fetch sets lastError and lastErrorOn and leaves the fetch
    // times alone (worker.js:62-80).
    const failing = (lastErrorOn: number) =>
      worker({
        name: 'missing',
        lastFetchedOn: null,
        lastJobStartedOn: null,
        lastError: {
          name: 'Error',
          message: 'Queue missing does not exist (Queue: missing, Worker: w1)',
        },
        lastErrorOn,
        lastJobDuration: 0,
      });
    const holder = worker({ id: 'w2', workId: 'w2', count: 1 });
    assert.deepStrictEqual(observed, {
      wip: [
        { at: 2000, workers: [failing(0), holder] },
        { at: 4000, workers: [failing(2000), holder] },
      ],
      errors: 3,
    });
  });

  it('stop with stop(), save the emit after a batch a graceful stop waits for', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, wip, stopped }) => {
        await queue.start();
        await queue.createQueue('jobs');
        const held = holding();
        await queue.work('jobs', { pollingIntervalSeconds: 2.5 }, held.handler);
        await queue.send('jobs', null, { id: id(1) });
        try {
          await clock.tick(2500);
          const stopping = queue.stop({ graceful: true, close: false });
          await clock.tick(3600);
          held.release();
          await stopping;
          await clock.tick(4000);
          return { wip: [...wip], stopped: [...stopped] };
        } finally {
          held.release();
        }
      },
    );

    // stop() clears the interval (manager.js:866-870), so nothing goes out
    // at 6000 while the batch is still held; the batch's own emit still runs,
    // from a worker now stopping (worker.js:102-114).
    const holder = worker({
      options: {
        pollingIntervalSeconds: 2.5,
        pollingInterval: 2500,
        notifyPollingInterval: 30000,
      },
      count: 1,
      lastFetchedOn: 2500,
      lastJobStartedOn: 2500,
      lastJobEndedOn: 0,
      lastJobDuration: 0,
    });
    assert.deepStrictEqual(observed, {
      wip: [
        { at: 2500, workers: [holder] },
        { at: 6100, workers: [{ ...holder, state: 'stopping' }] },
      ],
      stopped: [6100],
    });
  });
});

describe('stopped events', () => {
  it('fire after the shutdown fails and aborts the batch, before stop() resolves', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, stopped }) => {
        await queue.start();
        await queue.createQueue('jobs');
        await queue.send('jobs', null, { id: id(1) });
        let atAbort = -1;
        const held = Promise.withResolvers<void>();
        await queue.work('jobs', async ([job]) => {
          job?.signal.addEventListener('abort', () => {
            atAbort = stopped.length;
          });
          await held.promise;
        });
        try {
          await clock.tick(0);
          let atResolve = -1;
          const stopping = queue
            .stop({ graceful: false, close: false })
            .then(() => {
              atResolve = stopped.length;
            });
          const atCall = stopped.length;
          await stopping;
          const states = (await queue.findJobs('jobs')).map((job) => job.state);
          return { atCall, atAbort, atResolve, states, stopped: [...stopped] };
        } finally {
          held.resolve();
        }
      },
    );

    // `stopped` is the last step of the shutdown (node_modules/pg-boss/dist/
    // index.js:234-258), after failWip fails and aborts each batch.
    assert.deepStrictEqual(observed, {
      atCall: 0,
      atAbort: 0,
      atResolve: 1,
      states: ['retry'],
      stopped: [0],
    });
  });

  it('fire only for a stop that shuts a started queue down', async () => {
    const observed = await Parity.assertSame(async ({ queue, stopped }) => {
      await queue.stop();
      const beforeStart = [...stopped];
      await queue.start();
      await queue.stop({ close: false });
      await queue.stop({ close: false });
      await queue.stop();
      return { beforeStart, stopped: [...stopped] };
    });

    // A stop before start, a repeated one and a closing one after
    // close: false all find the instance stopped (index.js:206-217).
    assert.deepStrictEqual(observed, { beforeStart: [], stopped: [0] });
  });

  it('fire for a graceful stop only once the batch in flight ends', async () => {
    const observed = await Parity.assertSame(
      async ({ queue, clock, stopped }) => {
        await queue.start();
        await queue.createQueue('jobs');
        await queue.send('jobs', null, { id: id(1) });
        const held = holding();
        await queue.work('jobs', held.handler);
        try {
          await clock.tick(0);
          const stopping = queue.stop({ graceful: true, close: false });
          await clock.tick(0);
          const whileHeld = [...stopped];
          held.release();
          await stopping;
          const states = (await queue.findJobs('jobs')).map((job) => job.state);
          return { whileHeld, states, stopped: [...stopped] };
        } finally {
          held.release();
        }
      },
    );

    // A graceful stop waits for the workers' cleanups before the shutdown
    // (index.js:260-274).
    assert.deepStrictEqual(observed, {
      whileHeld: [],
      states: ['completed'],
      stopped: [0],
    });
  });

  it('fire for a stop after a start that threw once it had begun', async () => {
    // The harness's clock attaches, so each backend is built here around one
    // that refuses, on the database the harness would give it.
    const observe = async (queue: PgBoss | SqliteJobQueue) => {
      const stopped: string[] = [];
      queue.on('stopped', () => stopped.push('stopped'));
      const started = await outcome(() => queue.start());
      const stop = await outcome(() =>
        queue.stop({ graceful: false, close: false }),
      );
      const again = await outcome(() => queue.stop());
      return { started, stop, again, stopped };
    };
    const pglite = new PGlite();
    let pgBoss;
    try {
      pgBoss = await observe(
        new PgBoss({
          backend: 'pglite',
          db: fromPglite(pglite),
          clock: new RefusingClock(ParityRun.start),
          schedule: false,
          supervise: false,
          useListenNotify: true,
        }),
      );
    } finally {
      await pglite.close();
    }
    const database = new DatabaseSync(':memory:');
    let sqlite;
    try {
      sqlite = await observe(
        new SqliteJobQueue({
          database,
          clock: new RefusingClock(ParityRun.start),
          schedule: false,
          useListenNotify: true,
        }),
      );
    } finally {
      database.close();
    }

    // start() clears the instance's stopped flag before it runs
    // (index.js:118-125), so a start that threw leaves a stop to do.
    assert.deepStrictEqual(sqlite, pgBoss);
    assert.deepStrictEqual(pgBoss, {
      started: 'Error: attach refused',
      stop: 'resolved',
      again: 'resolved',
      stopped: ['stopped'],
    });
  });

  it('let a start wait for a stop in flight, and a stop for a start in flight', async () => {
    const observed = await Parity.assertSame(async ({ queue, stopped }) => {
      const [first, second] = await Promise.all([queue.start(), queue.start()]);
      await queue.createQueue('jobs');
      await Promise.all([queue.stop({ close: false }), queue.start()]);
      const afterRestart = {
        stopped: stopped.length,
        work: await outcome(() => queue.work('jobs', async () => {})),
      };
      await queue.stop({ close: false });
      await Promise.all([queue.start(), queue.stop({ close: false })]);
      const afterStopDuringStart = {
        stopped: stopped.length,
        work: await outcome(() => queue.work('jobs', async () => {})),
      };
      return {
        sameStart: first === queue && second === queue,
        afterRestart,
        afterStopDuringStart,
      };
    });

    // index.js:106-132, 195-200: each call waits for the other in flight.
    assert.deepStrictEqual(observed, {
      sameStart: true,
      afterRestart: { stopped: 1, work: 'resolved' },
      afterStopDuringStart: {
        stopped: 3,
        work: 'Error: Workers are disabled. pg-boss is stopped',
      },
    });
  });
});
