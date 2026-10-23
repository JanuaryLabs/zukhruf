import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { PgBoss, TestClock, fromPglite } from 'pg-boss';

import type { JobQueue } from '../index.ts';
import { SqliteJobQueue } from '../index.ts';
import { ParityRun, type RunOptions } from './backends.ts';
import { Observe } from './observe.ts';
import { Parity } from './parity.ts';

// The queue pg-boss's cron pass files each due occurrence in, which its own
// worker forwards to the schedule's queue (node_modules/pg-boss/dist/
// timekeeper.js:12-14).
const SEND_IT = '__pgboss__send-it';

// pg-boss's default cadence: a cron pass every 30 s, the send-it worker
// polling every 5 s (attorney.js:656-659).
const timekeeping = { schedule: true } satisfies RunOptions;

const origin = Date.parse(ParityRun.start);

// Lets everything due now finish on both backends: tick(0) waits until each
// one's statements in flight have settled (node_modules/pg-boss/dist/
// clock.js:88-117).
async function flush(clock: TestClock) {
  await clock.tick(0);
}

// Starts the queue and lets its first cron pass finish. pg-boss runs that
// pass on a real setImmediate (timekeeper.js:258), outside the clock, so
// every schedule a scenario writes afterwards is first seen at 30 s.
async function startTimekeeping({ queue, clock }: ParityRun) {
  await queue.start();
  await flush(clock);
}

// A queue's jobs as a caller reads them, without the random ids, in the
// order they were created.
async function jobs(queue: JobQueue, name: string) {
  return (await queue.findJobs(name))
    .map((job) => {
      const { id: _id, ...rest } = Observe.job(job);
      return rest;
    })
    .sort(
      (a, b) =>
        Number(a.createdOn) - Number(b.createdOn) ||
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
}

async function createdOn(queue: JobQueue, name: string) {
  return (await jobs(queue, name)).map((job) => job.createdOn);
}

function errorsOf(errors: Error[]) {
  return errors.map((error) => ({ name: error.name, message: error.message }));
}

// What a call did: 'resolved', or the error class and message it rejected
// or threw with.
async function outcome(call: () => unknown) {
  try {
    await call();
    return 'resolved';
  } catch (error) {
    return error instanceof Error
      ? `${error.name}: ${error.message}`
      : String(error);
  }
}

describe('timekeeper', () => {
  it('reports a forward its queue refuses as an error event and completes the send-it job (C12)', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('fifo', { policy: 'key_strict_fifo' });
      await run.queue.schedule('fifo', '* * * * *');
      await run.clock.tick(30_000);
      const at30 = errorsOf(run.errors);
      await run.clock.tick(30_000);
      return {
        at30,
        at60: errorsOf(run.errors),
        targets: await jobs(run.queue, 'fifo'),
        sendIt: (await jobs(run.queue, SEND_IT)).map(
          ({ state, createdOn, completedOn }) => ({
            state,
            createdOn,
            completedOn,
          }),
        ),
      };
    }, timekeeping);

    const refused = {
      name: 'Error',
      message: 'key_strict_fifo queues require a singletonKey',
    };
    assert.deepStrictEqual(observed, {
      at30: [refused],
      at60: [refused, refused],
      targets: [],
      sendIt: [
        { state: 'completed', createdOn: 30_000, completedOn: 30_000 },
        { state: 'completed', createdOn: 60_000, completedOn: 60_000 },
      ],
    });
  });

  it('drops the schedules of a deleted queue, so a queue recreated under its name receives nothing (C10)', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('jobs');
      await run.queue.schedule('jobs', '* * * * *');
      await run.queue.deleteQueue('jobs');
      await run.queue.createQueue('jobs');
      await run.clock.tick(65_000);
      return {
        targets: await jobs(run.queue, 'jobs'),
        sendIt: await jobs(run.queue, SEND_IT),
        errors: errorsOf(run.errors),
      };
    }, timekeeping);

    assert.deepStrictEqual(observed, { targets: [], sendIt: [], errors: [] });
  });

  it('retries a refused cron claim when the claim it lost to comes due, plus a beat (restart)', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('jobs');
      await run.queue.schedule('jobs', '* * * * *');
      await run.clock.tick(10_000);
      await run.queue.stop({ graceful: false, close: false });
      // The start pass at 10 s finds the claim stamped 10 s ago, so it waits
      // out the other 20 s of the interval and one more (timekeeper.js:
      // 368, 406-411) and runs at 31 s.
      await startTimekeeping(run);
      await run.clock.tick(30_000);
      return {
        targets: await createdOn(run.queue, 'jobs'),
        sendIt: await createdOn(run.queue, SEND_IT),
      };
    }, timekeeping);

    assert.deepStrictEqual(observed, { targets: [35_000], sendIt: [31_000] });
  });

  it('fires each key of a queue on its own and stops only the key unscheduled (C7)', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('jobs');
      await run.queue.schedule('jobs', '* * * * *', { key: 'a' }, { key: 'a' });
      await run.queue.schedule('jobs', '* * * * *', { key: 'b' }, { key: 'b' });
      await run.clock.tick(65_000);
      await run.queue.unschedule('jobs', 'a');
      await run.clock.tick(60_000);
      return {
        targets: (await jobs(run.queue, 'jobs')).map(({ createdOn, data }) => ({
          createdOn,
          data,
        })),
        sendIt: (await jobs(run.queue, SEND_IT)).map(
          ({ singletonKey, createdOn }) => ({ singletonKey, createdOn }),
        ),
      };
    }, timekeeping);

    assert.deepStrictEqual(observed, {
      targets: [
        { createdOn: 30_000, data: { key: 'a' } },
        { createdOn: 30_000, data: { key: 'b' } },
        { createdOn: 60_000, data: { key: 'a' } },
        { createdOn: 60_000, data: { key: 'b' } },
        { createdOn: 120_000, data: { key: 'b' } },
      ],
      sendIt: [
        { singletonKey: 'jobs__a', createdOn: 30_000 },
        { singletonKey: 'jobs__b', createdOn: 30_000 },
        { singletonKey: 'jobs__a', createdOn: 60_000 },
        { singletonKey: 'jobs__b', createdOn: 60_000 },
        { singletonKey: 'jobs__b', createdOn: 120_000 },
      ],
    });
  });

  it('sends a cron schedule once per minute slot through __pgboss__send-it, with its data and send options (C1)', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('jobs');
      await run.queue.schedule(
        'jobs',
        '* * * * *',
        { a: 1 },
        { singletonKey: 'k', priority: 3, retryLimit: 5 },
      );
      await run.clock.tick(185_000);
      return {
        targets: await jobs(run.queue, 'jobs'),
        sendIt: await jobs(run.queue, SEND_IT),
        errors: errorsOf(run.errors),
        // The send-it worker's batches emit no wip (manager.js:1067-1081).
        wip: [...run.wip],
      };
    }, timekeeping);

    assert.deepStrictEqual(
      observed.targets.map(
        ({ createdOn, data, singletonKey, priority, retryLimit, state }) => ({
          createdOn,
          data,
          singletonKey,
          priority,
          retryLimit,
          state,
        }),
      ),
      [30_000, 60_000, 120_000, 180_000].map((at) => ({
        createdOn: at,
        data: { a: 1 },
        singletonKey: 'k',
        priority: 3,
        retryLimit: 5,
        state: 'created',
      })),
    );
    assert.deepStrictEqual(
      observed.sendIt.map(
        ({
          createdOn,
          completedOn,
          state,
          singletonKey,
          singletonOn,
          policy,
          retryLimit,
          output,
          data,
        }) => ({
          createdOn,
          completedOn,
          state,
          singletonKey,
          singletonOn,
          policy,
          retryLimit,
          output,
          data,
        }),
      ),
      [
        ['2026-01-01 00:00:00', 30_000, 0],
        ['2026-01-01 00:01:00', 60_000, 60_000],
        ['2026-01-01 00:02:00', 120_000, 120_000],
        ['2026-01-01 00:03:00', 180_000, 180_000],
      ].map(([slot, at, utc]) => ({
        createdOn: at,
        completedOn: at,
        state: 'completed',
        singletonKey: 'jobs__',
        // A zoneless slot read back in the process's zone, Asia/Kolkata.
        singletonOn: Number(utc) - 19_800_000,
        policy: 'standard',
        retryLimit: 2,
        output: null,
        data: {
          name: 'jobs',
          key: '',
          data: { a: 1 },
          options: { singletonKey: 'k', priority: 3, retryLimit: 5 },
          slot,
        },
      })),
    );
    assert.deepStrictEqual(observed.errors, []);
    assert.deepStrictEqual(observed.wip, []);
  });

  it('files every occurrence of a seconds expression in its minute slot (C2)', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('jobs');
      await run.queue.schedule('jobs', '*/10 * * * * *');
      await run.clock.tick(125_000);
      return createdOn(run.queue, 'jobs');
    }, timekeeping);

    assert.deepStrictEqual(observed, [30_000, 60_000, 120_000]);
  });

  it('reads a cron expression in its tz, and in UTC without one (C3)', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('kolkata');
      await run.queue.createQueue('utc');
      // 05:31 in Kolkata is 00:01 UTC.
      await run.queue.schedule('kolkata', '31 5 * * *', null, {
        tz: 'Asia/Kolkata',
      });
      await run.queue.schedule('utc', '31 5 * * *');
      await run.clock.tick(125_000);
      return {
        kolkata: await createdOn(run.queue, 'kolkata'),
        utc: await createdOn(run.queue, 'utc'),
      };
    }, timekeeping);

    assert.deepStrictEqual(observed, { kolkata: [60_000], utc: [] });
  });

  it("catches up on the latest occurrence an outage missed only under missed: 'once' (C4)", async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      for (const name of ['once', 'skip', 'unset']) {
        await run.queue.createQueue(name);
      }
      await run.queue.schedule('once', '0 * * * *', null, { missed: 'once' });
      await run.queue.schedule('skip', '0 * * * *', null, { missed: 'skip' });
      await run.queue.schedule('unset', '0 * * * *');
      await run.clock.tick(30_000);
      // The process sleeps through 01:00, 02:00 and 03:00.
      await run.clock.setTime(origin + 12_600_000);
      await run.clock.tick(10_000);
      return {
        once: await createdOn(run.queue, 'once'),
        skip: await createdOn(run.queue, 'skip'),
        unset: await createdOn(run.queue, 'unset'),
        slots: (await jobs(run.queue, SEND_IT)).map(({ data }) => data),
      };
    }, timekeeping);

    assert.deepStrictEqual(observed.once, [30_000, 12_605_000]);
    assert.deepStrictEqual(observed.skip, [30_000]);
    assert.deepStrictEqual(observed.unset, [30_000]);
    assert.deepStrictEqual(
      observed.slots.filter(
        (data) =>
          typeof data === 'object' &&
          data !== null &&
          'name' in data &&
          data.name === 'once',
      ),
      [
        {
          name: 'once',
          key: '',
          data: null,
          options: { missed: 'once' },
          slot: '2026-01-01 00:00:00',
        },
        {
          name: 'once',
          key: '',
          data: null,
          options: { missed: 'once' },
          slot: '2026-01-01 03:00:00',
        },
      ],
    );
  });

  it('sends an rrule schedule at the occurrences of its rule (C5)', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('jobs');
      await run.queue.schedule('jobs', 'FREQ=MINUTELY;INTERVAL=2');
      await run.clock.tick(250_000);
      return createdOn(run.queue, 'jobs');
    }, timekeeping);

    assert.deepStrictEqual(observed, [30_000, 120_000, 240_000]);
  });

  it('still sends an occurrence that came due under a minute before the schedule was written (C8)', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('jobs');
      await run.clock.tick(10_000);
      await run.queue.schedule('jobs', '* * * * *');
      await run.clock.tick(20_000);
      return createdOn(run.queue, 'jobs');
    }, timekeeping);

    assert.deepStrictEqual(observed, [30_000]);
  });

  it('runs the cron pass and the send-it worker at the configured intervals (C9)', async () => {
    const observed = await Parity.assertSame(
      async (run) => {
        await startTimekeeping(run);
        await run.queue.createQueue('jobs');
        await run.queue.schedule('jobs', '* * * * *');
        await run.clock.tick(125_000);
        return {
          targets: await createdOn(run.queue, 'jobs'),
          sendIt: await createdOn(run.queue, SEND_IT),
        };
      },
      {
        ...timekeeping,
        cronMonitorIntervalSeconds: 1,
        cronWorkerIntervalSeconds: 1,
      },
    );

    // At each second the poll, armed first, fetches before the pass files
    // the occurrence, so the job goes out a second later.
    assert.deepStrictEqual(observed, {
      targets: [2_000, 61_000, 121_000],
      sendIt: [1_000, 60_000, 120_000],
    });
  });

  it('forwards startAfter and expireInSeconds, with key, tz and missed among the options it sends (C13)', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('jobs');
      await run.queue.schedule('jobs', '* * * * *', null, {
        startAfter: 90,
        key: 'k',
        tz: 'Asia/Kolkata',
        missed: 'once',
        expireInSeconds: 30,
      });
      await run.clock.tick(30_000);
      return jobs(run.queue, 'jobs');
    }, timekeeping);

    assert.deepStrictEqual(
      observed.map(({ createdOn, startAfter, expireInSeconds, data }) => ({
        createdOn,
        startAfter,
        expireInSeconds,
        data,
      })),
      [
        {
          createdOn: 30_000,
          startAfter: 120_000,
          expireInSeconds: 30,
          data: null,
        },
      ],
    );
  });

  it('lists a busy worker in wip but never the send-it worker', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('jobs');
      await run.queue.schedule('jobs', '* * * * *');
      const held = Promise.withResolvers<void>();
      try {
        await run.queue.work('jobs', () => held.promise);
        await run.clock.tick(65_000);
      } finally {
        held.resolve();
      }
      await flush(run.clock);
      return run.wip.map(({ at, workers }) => ({
        at,
        workers: workers.map(({ name, count }) => ({ name, count })),
      }));
    }, timekeeping);

    assert.ok(observed.length > 0, 'pg-boss emitted no wip');
    assert.ok(
      observed.every(({ workers }) =>
        workers.every(({ name }) => name === 'jobs'),
      ),
    );
  });

  it('sends nothing while stopped', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('jobs');
      await run.queue.schedule('jobs', '* * * * *');
      await run.queue.stop({ graceful: false, close: false });
      await run.clock.tick(65_000);
      return {
        targets: await jobs(run.queue, 'jobs'),
        sendIt: await jobs(run.queue, SEND_IT),
      };
    }, timekeeping);

    assert.deepStrictEqual(observed, { targets: [], sendIt: [] });
  });

  it("owes missed: 'once' nothing from before the schedule was written", async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('early');
      await run.queue.createQueue('late');
      await run.queue.schedule('early', '0 * * * *', null, { missed: 'once' });
      await run.clock.tick(30_000);
      await run.clock.setTime(origin + 12_600_000);
      // Written after the outage, so 03:00 came due before it existed
      // (timekeeper.js:591-601).
      await run.queue.schedule('late', '0 * * * *', null, { missed: 'once' });
      await run.clock.tick(10_000);
      return {
        early: await createdOn(run.queue, 'early'),
        late: await createdOn(run.queue, 'late'),
      };
    }, timekeeping);

    assert.deepStrictEqual(observed, {
      early: [30_000, 12_605_000],
      late: [],
    });
  });

  it('fires a rewritten schedule with its new expression, data and options only', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('jobs');
      await run.queue.schedule('jobs', '0 0 1 1 *', { v: 1 }, { priority: 1 });
      await run.queue.schedule('jobs', '* * * * *', { v: 2 }, { priority: 2 });
      await run.clock.tick(65_000);
      return (await jobs(run.queue, 'jobs')).map(
        ({ createdOn, data, priority }) => ({ createdOn, data, priority }),
      );
    }, timekeeping);

    assert.deepStrictEqual(observed, [
      { createdOn: 30_000, data: { v: 2 }, priority: 2 },
      { createdOn: 60_000, data: { v: 2 }, priority: 2 },
    ]);
  });

  it('keeps time by default, and not when schedule is given as undefined', async () => {
    // Built by hand: the harness always names schedule (attorney.js:412).
    const read = async (queue: JobQueue, clock: TestClock) => {
      try {
        await queue.start();
        await flush(clock);
        const sendIt = await outcome(() => queue.findJobs(SEND_IT));
        await queue.createQueue('jobs');
        await queue.schedule('jobs', '* * * * *');
        await clock.tick(30_000);
        return { sendIt, targets: (await queue.findJobs('jobs')).length };
      } finally {
        await queue.stop({ graceful: false, close: false });
      }
    };
    const observe = async (options: object) => {
      const pglite = new PGlite();
      const database = new DatabaseSync(':memory:');
      try {
        const pgBossClock = new TestClock(ParityRun.start);
        const sqliteClock = new TestClock(ParityRun.start);
        return {
          pgBoss: await read(
            new PgBoss({
              backend: 'pglite',
              db: fromPglite(pglite),
              clock: pgBossClock,
              supervise: false,
              ...options,
            }),
            pgBossClock,
          ),
          sqlite: await read(
            new SqliteJobQueue({
              database,
              clock: sqliteClock,
              supervise: false,
              ...options,
            }),
            sqliteClock,
          ),
        };
      } finally {
        database.close();
        await pglite.close();
      }
    };

    const keeping = { sendIt: 'resolved', targets: 1 };
    assert.deepStrictEqual(await observe({}), {
      pgBoss: keeping,
      sqlite: keeping,
    });
    const idle = {
      sendIt: `Error: Queue ${SEND_IT} does not exist`,
      targets: 0,
    };
    assert.deepStrictEqual(await observe({ schedule: undefined }), {
      pgBoss: idle,
      sqlite: idle,
    });
  });

  it('holds a filed occurrence through a stop and forwards it after the restart', async () => {
    const observed = await Parity.assertSame(
      async (run) => {
        await startTimekeeping(run);
        await run.queue.createQueue('jobs');
        await run.queue.schedule('jobs', '* * * * *');
        // The pass files the 00:00 occurrence at 30 s; the poll is due at
        // 35 s.
        await run.clock.tick(31_000);
        await run.queue.stop({ graceful: false, close: false });
        await run.clock.tick(10_000);
        const whileStopped = await createdOn(run.queue, 'jobs');
        await startTimekeeping(run);
        return {
          whileStopped,
          afterRestart: await createdOn(run.queue, 'jobs'),
        };
      },
      { ...timekeeping, cronWorkerIntervalSeconds: 7 },
    );

    assert.deepStrictEqual(observed, {
      whileStopped: [],
      afterRestart: [41_000],
    });
  });

  it('files a queue name with an underscore apart from a key that starts with one', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('a_');
      await run.queue.createQueue('a');
      // Unescaped, both would be filed under a___x and one would be lost
      // (timekeeper.js:49-68).
      await run.queue.schedule('a_', '* * * * *', null, { key: 'x' });
      await run.queue.schedule('a', '* * * * *', null, { key: '_x' });
      await run.clock.tick(30_000);
      return {
        underscoredName: await createdOn(run.queue, 'a_'),
        underscoredKey: await createdOn(run.queue, 'a'),
        sendIt: (await jobs(run.queue, SEND_IT))
          .map(({ singletonKey }) => singletonKey)
          .sort(),
      };
    }, timekeeping);

    assert.deepStrictEqual(observed, {
      underscoredName: [30_000],
      underscoredKey: [30_000],
      sendIt: ['a\\___x', 'a___x'],
    });
  });

  it("catches up on an rrule schedule's latest missed occurrence under missed: 'once'", async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('daily');
      await run.queue.createQueue('halfHourly');
      // Daily at 01:00: the latest missed occurrence lies hours behind the
      // window, so the backwards read widens its steps (rrule.js:323-356).
      await run.queue.schedule(
        'daily',
        'FREQ=DAILY;BYHOUR=1;BYMINUTE=0;BYSECOND=0',
        null,
        { missed: 'once' },
      );
      // Every 30 minutes: the first backwards step holds 02:30 and 03:00,
      // and the latest of them is owed.
      await run.queue.schedule(
        'halfHourly',
        'FREQ=MINUTELY;INTERVAL=30',
        null,
        {
          missed: 'once',
        },
      );
      await run.clock.tick(30_000);
      await run.clock.setTime(origin + 12_600_000);
      await run.clock.tick(10_000);
      return {
        daily: await createdOn(run.queue, 'daily'),
        halfHourly: await createdOn(run.queue, 'halfHourly'),
        slots: (await jobs(run.queue, SEND_IT))
          .map(({ data }) =>
            typeof data === 'object' &&
            data !== null &&
            'name' in data &&
            'slot' in data
              ? `${String(data.name)} ${String(data.slot)}`
              : null,
          )
          .sort(),
      };
    }, timekeeping);

    assert.deepStrictEqual(observed, {
      daily: [12_605_000],
      // 03:00 is owed for the gap, and 03:30 is due now.
      halfHourly: [30_000, 12_605_000, 12_605_000],
      slots: [
        'daily 2026-01-01 01:00:00',
        'halfHourly 2026-01-01 00:00:00',
        'halfHourly 2026-01-01 03:00:00',
        'halfHourly 2026-01-01 03:30:00',
      ],
    });
  });

  it('completes the send-it job of a refused forward when nothing listens for error', async () => {
    // Built by hand: the harness always listens for error. With no listener
    // the error event throws, and the send-it handler must still resolve
    // (timekeeper.js:654-665).
    const observe = async (queue: JobQueue, clock: TestClock) => {
      try {
        await queue.start();
        await flush(clock);
        await queue.createQueue('fifo', { policy: 'key_strict_fifo' });
        await queue.schedule('fifo', '* * * * *');
        await clock.tick(30_000);
        return (await queue.findJobs(SEND_IT)).map(({ state }) => state);
      } finally {
        await queue.stop({ graceful: false, close: false });
      }
    };
    const pglite = new PGlite();
    const database = new DatabaseSync(':memory:');
    try {
      const pgBossClock = new TestClock(ParityRun.start);
      const sqliteClock = new TestClock(ParityRun.start);
      const pgBoss = await observe(
        new PgBoss({
          backend: 'pglite',
          db: fromPglite(pglite),
          clock: pgBossClock,
          supervise: false,
        }),
        pgBossClock,
      );
      const sqlite = await observe(
        new SqliteJobQueue({ database, clock: sqliteClock, supervise: false }),
        sqliteClock,
      );

      assert.deepStrictEqual(sqlite, pgBoss);
      assert.deepStrictEqual(pgBoss, ['completed']);
    } finally {
      database.close();
      await pglite.close();
    }
  });

  it('runs no timekeeper with schedule: false', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await run.queue.start();
      await run.queue.createQueue('jobs');
      await run.queue.schedule('jobs', '* * * * *');
      await run.clock.tick(65_000);
      return {
        targets: await jobs(run.queue, 'jobs'),
        sendIt: await outcome(() => run.queue.findJobs(SEND_IT)),
      };
    });

    assert.deepStrictEqual(observed, {
      targets: [],
      sendIt: `Error: Queue ${SEND_IT} does not exist`,
    });
  });

  it('validates the timekeeper options in pg-boss order, when built', async () => {
    // Plain objects, so values the option types exclude reach both.
    const cases: object[] = [
      { cronMonitorIntervalSeconds: 0 },
      { cronMonitorIntervalSeconds: 46 },
      { cronMonitorIntervalSeconds: undefined },
      { cronMonitorIntervalSeconds: 45, cronWorkerIntervalSeconds: 1 },
      { cronWorkerIntervalSeconds: 0 },
      { cronWorkerIntervalSeconds: 45.5 },
      { cronWorkerIntervalSeconds: null },
      { clockMonitorIntervalSeconds: 0 },
      { clockMonitorIntervalSeconds: 601 },
      { clockMonitorIntervalSeconds: 600 },
      { clockMonitorIntervalSeconds: 0, cronMonitorIntervalSeconds: 0 },
      { cronMonitorIntervalSeconds: 0, cronWorkerIntervalSeconds: 0 },
      { superviseIntervalSeconds: 0, cronMonitorIntervalSeconds: 0 },
      { cronWorkerIntervalSeconds: 0, warningQueueSize: 0 },
      { schedule: false, cronMonitorIntervalSeconds: 0 },
    ];
    // Neither is started: pg-boss validates in its constructor
    // (index.js:65, attorney.js:407-426), before it touches its database.
    const pglite = new PGlite();
    const database = new DatabaseSync(':memory:');
    const pgBoss: string[] = [];
    const sqlite: string[] = [];
    try {
      for (const options of cases) {
        pgBoss.push(
          await outcome(
            () =>
              new PgBoss({
                backend: 'pglite',
                db: fromPglite(pglite),
                ...options,
              }),
          ),
        );
        sqlite.push(
          await outcome(() => new SqliteJobQueue({ database, ...options })),
        );
      }
    } finally {
      database.close();
      await pglite.close();
    }

    assert.deepStrictEqual(sqlite, pgBoss);
    const failed = (message: string) =>
      `AssertionError: configuration assert: ${message}`;
    const cronMonitor = failed(
      'cronMonitorIntervalSeconds must be between 1 and 45 seconds',
    );
    const cronWorker = failed(
      'cronWorkerIntervalSeconds must be between 1 and 45 seconds',
    );
    const clockMonitor = failed(
      'clockMonitorIntervalSeconds must be between 1 second and 10 minutes',
    );
    assert.deepStrictEqual(pgBoss, [
      cronMonitor,
      cronMonitor,
      cronMonitor,
      'resolved',
      cronWorker,
      cronWorker,
      cronWorker,
      clockMonitor,
      clockMonitor,
      'resolved',
      clockMonitor,
      cronMonitor,
      failed('superviseIntervalSeconds must be at least every second'),
      cronWorker,
      cronMonitor,
    ]);
  });
});
