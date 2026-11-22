import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PGlite } from '@electric-sql/pglite';
import { type AttachableClock, PgBoss, TestClock, fromPglite } from 'pg-boss';

import { open } from '@zukhruf/sqlite-open';

import type { JobQueue } from '../index.ts';
import { SqliteJobQueue } from '../index.ts';
import { DateFollowsClock } from '../testing/date-follows-clock.ts';
import { flush } from '../testing/flush.ts';
import { outcome } from '../testing/outcome.ts';
import { ParityRun, type RunOptions } from './backends.ts';
import { Observe } from './observe.ts';
import { Parity } from './parity.ts';

// The queue pg-boss's cron pass files each due occurrence in, which its own
// worker forwards to the schedule's queue (node_modules/pg-boss/dist/
// timekeeper.js:13-15).
const SEND_IT = '__pgboss__send-it';

// pg-boss's default cadence: a cron pass every 30 s, the send-it worker
// polling every 5 s (attorney.js:710-713).
const timekeeping = { schedule: true } satisfies RunOptions;

const origin = Date.parse(ParityRun.start);

// Starts the queue and lets its first cron pass finish. pg-boss runs that
// pass on a real setImmediate (timekeeper.js:410), outside the clock, so
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

// A clock seen through a record of the sub-second timers an instance arms,
// in ms since the start: the one trace a one-second tick leaves on an instance
// with nothing to send (timekeeper.js:439-458, 12.39.0). The clock is an input.
class SubSecondTimers implements AttachableClock {
  readonly armed: number[] = [];
  readonly #clock: TestClock;

  constructor(clock: TestClock) {
    this.#clock = clock;
  }

  now() {
    return this.#clock.now();
  }

  setTimeout(fn: () => void, ms: number) {
    if (ms <= 1000) {
      this.armed.push(this.#clock.now() - origin);
    }
    return this.#clock.setTimeout(fn, ms);
  }

  clearTimeout(handle: unknown) {
    this.#clock.clearTimeout(handle);
  }

  setInterval(fn: () => void, ms: number) {
    return this.#clock.setInterval(fn, ms);
  }

  clearInterval(handle: unknown) {
    this.#clock.clearInterval(handle);
  }

  attach(target: Parameters<AttachableClock['attach']>[0]) {
    return this.#clock.attach(target);
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
      // 407, 445-450) and runs at 31 s.
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
        // The send-it worker's batches emit no wip (manager.js:1399-1413).
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

  it("sends a job for each occurrence of a precision: 'second' schedule, every second, across the claims that renew its lease", async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('jobs');
      await run.queue.schedule(
        'jobs',
        '*/2 * * * * *',
        { a: 1 },
        { precision: 'second', priority: 3 },
      );
      await run.clock.tick(95_000);
      const targets = await jobs(run.queue, 'jobs');
      return {
        createdOn: targets.map(({ createdOn }) => createdOn),
        fields: [
          ...new Set(
            targets.map(({ data, priority, singletonKey, state }) =>
              JSON.stringify({ data, priority, singletonKey, state }),
            ),
          ),
        ],
        sendIt: (await jobs(run.queue, SEND_IT)).length,
        errors: errorsOf(run.errors),
        warnings: run.warnings.map(({ message }) => message),
      };
    }, timekeeping);

    // timekeeper.js:591-609, 671-705, 831-857 (12.39.0): the pass at 30 s
    // sends the occurrences since the schedule was written (its sent_on), and
    // the tick armed by the claim sends each one as it comes due, the pass
    // at 60 s and 90 s renewing the lease. None goes through send-it.
    const createdOn = [
      ...Array.from({ length: 15 }, () => 30_000),
      ...Array.from({ length: 32 }, (_, i) => 32_000 + i * 2000),
    ];
    assert.deepStrictEqual(observed, {
      createdOn,
      fields: [
        JSON.stringify({
          data: { a: 1 },
          priority: 3,
          singletonKey: null,
          state: 'created',
        }),
      ],
      sendIt: 0,
      errors: [],
      warnings: [],
    });
  });

  it("keeps a precision: 'second' schedule's place when it is written again unchanged at boot, sending what came due while stopped and nothing it sent before", async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('jobs');
      const schedule = () =>
        run.queue.schedule('jobs', '*/2 * * * * *', null, {
          precision: 'second',
        });
      await schedule();
      await run.clock.tick(41_000);
      await run.queue.stop({ graceful: false, close: false });
      await run.clock.tick(9_000);
      const beforeRestart = await createdOn(run.queue, 'jobs');
      await schedule();
      await startTimekeeping(run);
      await run.clock.tick(15_000);
      return {
        beforeRestart,
        afterRestart: (await createdOn(run.queue, 'jobs')).slice(
          beforeRestart.length,
        ),
      };
    }, timekeeping);

    // plans.js:1807-1827 (12.39.0): the same expression, zone and precision
    // keep sent_on at 40 s. The claim stamped at 30 s comes due at 60 s, so
    // the restarted instance's first pass runs at 61 s, with no hint of its
    // own: it sends 42 s to 60 s, and none of the occurrences up to 40 s again.
    assert.deepStrictEqual(observed, {
      beforeRestart: [
        ...Array.from({ length: 15 }, () => 30_000),
        32_000,
        34_000,
        36_000,
        38_000,
        40_000,
      ],
      afterRestart: [
        ...Array.from({ length: 10 }, () => 61_000),
        62_000,
        64_000,
      ],
    });
  });

  it("starts a precision: 'second' schedule's place again when it is written with a new expression, zone or precision, and only then", async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      const first = {
        same: ['*/2 * * * * *', { v: 1 }, { precision: 'second' }],
        data: ['*/2 * * * * *', { v: 1 }, { precision: 'second' }],
        cron: ['*/3 * * * * *', { v: 1 }, { precision: 'second' }],
        tz: ['*/2 * * * * *', { v: 1 }, { precision: 'second' }],
        precision: ['*/2 * * * * *', { v: 1 }, {}],
      } as const;
      const second = {
        same: ['*/2 * * * * *', { v: 1 }, { precision: 'second' }],
        data: ['*/2 * * * * *', { v: 2 }, { precision: 'second' }],
        cron: ['*/2 * * * * *', { v: 1 }, { precision: 'second' }],
        tz: [
          '*/2 * * * * *',
          { v: 1 },
          { precision: 'second', tz: 'Asia/Kolkata' },
        ],
        precision: ['*/2 * * * * *', { v: 1 }, { precision: 'second' }],
      } as const;
      for (const [name, [cron, data, options]] of Object.entries(first)) {
        await run.queue.createQueue(name);
        await run.queue.schedule(name, cron, data, options);
      }
      // No pass runs before 30 s, so each schedule's sent_on alone decides
      // where the pass starts sending.
      await run.clock.tick(10_000);
      for (const [name, [cron, data, options]] of Object.entries(second)) {
        await run.queue.schedule(name, cron, data, options);
      }
      await run.clock.tick(21_000);
      return Object.fromEntries(
        await Promise.all(
          Object.keys(first).map(
            async (name) =>
              [name, (await createdOn(run.queue, name)).length] as const,
          ),
        ),
      );
    }, timekeeping);

    // plans.js:1807-1827 (12.39.0): sent_on stays at 0 s for a rewrite of
    // the data alone, so the pass at 30 s sends 2 s to 30 s; a new
    // expression, zone or precision moves it to the rewrite at 10 s, and the
    // pass sends 12 s to 30 s.
    assert.deepStrictEqual(observed, {
      same: 15,
      data: 15,
      cron: 10,
      tz: 10,
      precision: 10,
    });
  });

  it('arms no one-second tick on an instance that lost the cron claim, or that holds it with no second-precision schedule', async () => {
    // Built by hand: two instances share one database and one clock, each
    // seeing it through its own SubSecondTimers.
    const read = async (
      clock: TestClock,
      build: (clock: AttachableClock) => JobQueue,
    ) => {
      const holderTimers = new SubSecondTimers(clock);
      const otherTimers = new SubSecondTimers(clock);
      const holder = build(holderTimers);
      const other = build(otherTimers);
      using dateFollowsClock = new DateFollowsClock(clock);
      try {
        await holder.start();
        await flush(clock);
        await holder.createQueue('seconds');
        await holder.createQueue('minutes');
        // A seconds field without precision: 'second' keeps a job a minute.
        await holder.schedule('minutes', '* * * * * *');
        await clock.tick(65_000);
        const minutesOnly = [...holderTimers.armed];
        await other.start();
        await flush(clock);
        await holder.schedule('seconds', '* * * * * *', null, {
          precision: 'second',
        });
        await clock.tick(30_000);
        return {
          minutesOnly,
          holder: holderTimers.armed.length > 0,
          other: otherTimers.armed,
          minutes: (await holder.findJobs('minutes')).length,
        };
      } finally {
        await other.stop({ graceful: false, close: false });
        await holder.stop({ graceful: false, close: false });
      }
    };

    await using pglite = new PGlite();
    using database = open(':memory:');
    const pgBoss = await read(
      new TestClock(ParityRun.start),
      (clock) =>
        new PgBoss({
          backend: 'pglite',
          db: fromPglite(pglite),
          clock,
          supervise: false,
        }),
    );
    const sqlite = await read(
      new TestClock(ParityRun.start),
      (clock) => new SqliteJobQueue({ database, clock, supervise: false }),
    );

    assert.deepStrictEqual(sqlite, pgBoss);
    assert.deepStrictEqual(pgBoss, {
      minutesOnly: [],
      holder: true,
      other: [],
      minutes: 2,
    });
  });

  it('lets a running tick lapse once another instance takes the cron claim, or once its last second-precision schedule is removed', async () => {
    // Built by hand: two instances on one database and one clock. The second
    // claims every 10 s, so it takes the claim from the first, whose lease
    // then runs out at 60 s; unscheduling at 80 s empties the second's cache
    // (timekeeper.js:439-458, 949-963, 12.39.0).
    const read = async (
      clock: TestClock,
      build: (
        clock: AttachableClock,
        cronMonitorIntervalSeconds: number,
      ) => JobQueue,
    ) => {
      const firstTimers = new SubSecondTimers(clock);
      const secondTimers = new SubSecondTimers(clock);
      const first = build(firstTimers, 30);
      const second = build(secondTimers, 10);
      using dateFollowsClock = new DateFollowsClock(clock);
      try {
        await first.start();
        await flush(clock);
        await first.createQueue('seconds');
        await first.schedule('seconds', '* * * * * *', null, {
          precision: 'second',
        });
        await clock.tick(35_000);
        await second.start();
        await flush(clock);
        await clock.tick(45_000);
        await first.unschedule('seconds');
        await clock.tick(40_000);
        return {
          firstLast: Math.max(...firstTimers.armed),
          secondLast: Math.max(...secondTimers.armed),
          sent: (await createdOn(first, 'seconds')).length,
        };
      } finally {
        await second.stop({ graceful: false, close: false });
        await first.stop({ graceful: false, close: false });
      }
    };

    await using pglite = new PGlite();
    using database = open(':memory:');
    const pgBoss = await read(
      new TestClock(ParityRun.start),
      (clock, cronMonitorIntervalSeconds) =>
        new PgBoss({
          backend: 'pglite',
          db: fromPglite(pglite),
          clock,
          cronMonitorIntervalSeconds,
          supervise: false,
        }),
    );
    const sqlite = await read(
      new TestClock(ParityRun.start),
      (clock, cronMonitorIntervalSeconds) =>
        new SqliteJobQueue({
          database,
          clock,
          cronMonitorIntervalSeconds,
          supervise: false,
        }),
    );

    assert.deepStrictEqual(sqlite, pgBoss);
    // The first arms its last tick at 59 s, for its lease's end at 60 s; the
    // second its last at 80 s, whose statement matches nothing. One job a
    // second through both, none twice while both held a lease.
    assert.deepStrictEqual(pgBoss, {
      firstLast: 59_000,
      secondLast: 80_000,
      sent: 80,
    });
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

  it('skips a stored schedule with an empty cron and warns once, for a row an earlier release wrote', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('jobs');
      await run.queue.schedule('jobs', '* * * * *');
      // schedule() refuses '' now; a file an earlier release wrote can hold
      // it, which no operation can write any more.
      await run.sql(
        `UPDATE ${run.backend === 'pg-boss' ? 'pgboss.schedule' : 'pgboss_schedule'} SET cron = ''`,
      );
      await run.clock.tick(95_000);
      return {
        targets: await createdOn(run.queue, 'jobs'),
        warnings: run.warnings.map(({ at, message, data }) => ({
          at,
          message,
          data,
        })),
      };
    }, timekeeping);

    // timekeeper.js:678-718, 1003 (12.37.0): cron-parser would read '' as
    // every minute, so the pass refuses it, skips the row and warns once.
    assert.deepStrictEqual(observed, {
      targets: [],
      warnings: [
        {
          at: 30_000,
          message:
            'Warning: schedule for queue "jobs" (key "") could not be evaluated and was skipped: cron expression must be a non-empty string',
          data: { queue: 'jobs', key: '', cron: '', timezone: 'UTC' },
        },
      ],
    });
  });

  it('sends a daily cron once on the night its local time repeats, at the first of its two instants', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      await run.queue.createQueue('jobs');
      await run.queue.schedule('jobs', '30 1 * * *', null, {
        tz: 'America/New_York',
      });
      // On 2026-11-01 New York's clocks go back from 02:00 EDT to 01:00 EST,
      // so 01:30 is 05:30Z and again 06:30Z.
      await run.clock.setTime(Date.parse('2026-11-01T05:29:30.000Z'));
      for (let minute = 0; minute < 62; minute++) {
        await run.clock.tick(60_000);
      }
      return (await createdOn(run.queue, 'jobs')).map((at) =>
        new Date(origin + Number(at)).toISOString(),
      );
    }, timekeeping);

    // previousOccurrence (12.38.1: timekeeper.js:85-195) reads backwards the
    // way the forward walk reads forwards: the second instant of a repeated
    // local time is skipped unless the hour field lists every hour.
    assert.deepStrictEqual(observed, ['2026-11-01T05:30:00.000Z']);
  });

  it('keeps sending a cron that names several minutes across several hours through the hour its local time repeats, and only such a cron', async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      const expressions = {
        run: '*/5 0-3 * * *',
        oneHour: '*/5 1 * * *',
        oneMinute: '30 0-3 * * *',
      };
      for (const [name, cron] of Object.entries(expressions)) {
        await run.queue.createQueue(name);
        await run.queue.schedule(name, cron, null, { tz: 'America/New_York' });
      }
      // 01:00 to 01:59 runs twice on 2026-11-01: 05:00Z to 05:59Z in EDT,
      // then 06:00Z to 06:59Z in EST.
      await run.clock.setTime(Date.parse('2026-11-01T05:49:30.000Z'));
      for (let minute = 0; minute < 45; minute++) {
        await run.clock.tick(60_000);
      }
      return Object.fromEntries(
        await Promise.all(
          Object.keys(expressions).map(
            async (name) =>
              [
                name,
                (await createdOn(run.queue, name)).map((at) =>
                  new Date(origin + Number(at)).toISOString().slice(11, 16),
                ),
              ] as const,
          ),
        ),
      );
    }, timekeeping);

    // passedOver (timekeeper.js:173-184, 12.39.0, #1007): several minutes
    // across several hours is a run, not a time of day, so both instants of
    // the repeated hour are sent; one hour, or one minute, still sends the
    // repeated hour once.
    assert.deepStrictEqual(observed, {
      run: [
        '05:50',
        '05:55',
        '06:00',
        '06:05',
        '06:10',
        '06:15',
        '06:20',
        '06:25',
        '06:30',
      ],
      oneHour: ['05:50', '05:55'],
      oneMinute: [],
    });
  });

  it("catches up under missed: 'once' on the occurrence before a day whose local time the clocks skipped", async () => {
    const observed = await Parity.assertSame(async (run) => {
      await startTimekeeping(run);
      const schedule = (name: string) =>
        run.queue.schedule(name, '30 30 0 * * *', null, {
          tz: 'America/Havana',
          missed: 'once',
          precision: 'second',
        });
      await run.queue.createQueue('early');
      await run.queue.createQueue('late');
      await schedule('early');
      await run.clock.tick(30_000);
      // The process sleeps from 2026-01-01 to noon UTC on 2026-03-08, when
      // Havana's clocks went from 00:00 to 01:00, so 00:30:30 never showed
      // that day and prev() finds no occurrence within its loop limit. 'late'
      // is written during the sleep, after 2026-03-07's 00:30:30 (05:30:30Z).
      await run.clock.setTime(Date.parse('2026-03-07T10:00:00.000Z'));
      await schedule('late');
      await run.clock.setTime(Date.parse('2026-03-08T12:00:00.000Z'));
      await run.clock.tick(10_000);
      return {
        early: await createdOn(run.queue, 'early'),
        late: await createdOn(run.queue, 'late'),
        warnings: run.warnings.map(({ message }) => message),
      };
    }, timekeeping);

    // latestOccurrenceBefore (timekeeper.js:1067-1092, 12.39.0) reads the day
    // prev() cannot read forwards, where it finds only the skipped
    // occurrence, which the expression does not name, and steps back a day to
    // 2026-03-07T05:30:30Z, which 'late' does not owe.
    assert.deepStrictEqual(observed, {
      early: [Date.parse('2026-03-08T12:00:00.000Z') - origin],
      late: [],
      warnings: [],
    });
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
      // (timekeeper.js:1048-1058).
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
    // Built by hand: the harness always names schedule (attorney.js:415).
    const read = async (queue: JobQueue, clock: TestClock) => {
      using dateFollowsClock = new DateFollowsClock(clock);
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
      await using pglite = new PGlite();
      using database = open(':memory:');

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
      // (timekeeper.js:54-73).
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
    // (timekeeper.js:1125-1136).
    const observe = async (queue: JobQueue, clock: TestClock) => {
      using dateFollowsClock = new DateFollowsClock(clock);
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

    await using pglite = new PGlite();
    using database = open(':memory:');

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
    // (index.js:82, attorney.js:410-431), before it touches its database.
    const pglite = new PGlite();
    const database = open(':memory:');
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
