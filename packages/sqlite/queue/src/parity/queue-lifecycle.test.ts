import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { type Clock, PgBoss, type UpdateQueueOptions } from 'pg-boss';

import { SqliteJobQueue } from '../index.ts';
import { Parity } from './parity.ts';

// { retryLimit: undefined }, which pg-boss's types cannot hold under
// exactOptionalPropertyTypes.
const onlyUndefined = (): UpdateQueueOptions => {
  const options: UpdateQueueOptions = {};
  Reflect.set(options, 'retryLimit', undefined);
  return options;
};

// What a call did: resolved, or the error class and message it rejected with,
// plus a driver error's SQLSTATE (pg-boss's validation throws AssertionError,
// its other guards Error).
async function outcome(call: () => Promise<unknown>) {
  try {
    await call();
    return 'resolved';
  } catch (error) {
    if (!(error instanceof Error)) {
      return String(error);
    }
    const code =
      error.name === 'error' && 'code' in error ? ` (${error.code})` : '';
    return `${error.name}: ${error.message}${code}`;
  }
}

describe('queue lifecycle', () => {
  it('rejects a clock missing any method at construction, as pg-boss does', () => {
    // Each clock arrives untyped, the way a JavaScript caller passes one.
    const clocks = {
      empty: JSON.parse('{}'),
      nowOnly: Object.assign(JSON.parse('{}'), { now: () => 0 }),
      noIntervals: Object.assign(JSON.parse('{}'), {
        now: () => 0,
        setTimeout: () => 0,
        clearTimeout: () => {},
      }),
    };
    const thrown = (construct: () => unknown) => {
      try {
        construct();
        return 'constructed';
      } catch (error) {
        return error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error);
      }
    };
    const observe = (construct: (clock: Clock) => unknown) =>
      Object.fromEntries(
        Object.entries(clocks).map(([label, clock]) => [
          label,
          thrown(() => construct(clock)),
        ]),
      );

    // pg-boss checks the clock while reading its configuration, before it
    // touches a database (node_modules/pg-boss/dist/attorney.js:428-437).
    const pgBoss = observe(
      (clock) =>
        new PgBoss({
          connectionString: 'postgres://unused',
          clock,
        }),
    );
    const sqlite = observe(
      (clock) => new SqliteJobQueue({ schedule: false, clock }),
    );

    assert.deepStrictEqual(sqlite, pgBoss);
    assert.deepStrictEqual(pgBoss, {
      empty: 'AssertionError: configuration assert: clock must implement now()',
      nowOnly:
        'AssertionError: configuration assert: clock must implement setTimeout()',
      noIntervals:
        'AssertionError: configuration assert: clock must implement setInterval()',
    });
  });

  it('rejects or accepts each call around start and stop as pg-boss does', async () => {
    // Both backends run on a caller-supplied database, so a call before
    // start() reaches SQL and fails on the missing schema with each engine's
    // own catalog error; only rejected-or-not is pg-boss's contract there.
    const settled = (result: string) =>
      result === 'resolved' ? 'resolved' : 'rejected';

    const observed = await Parity.assertSame(async ({ queue }) => {
      const beforeStart = {
        createQueue: settled(await outcome(() => queue.createQueue('early'))),
        send: settled(await outcome(() => queue.send('early', { n: 1 }))),
        findJobs: settled(await outcome(() => queue.findJobs('early'))),
        work: settled(
          await outcome(() => queue.work('early', {}, async () => {})),
        ),
      };
      const started = await queue.start();
      const startedAgain = await queue.start();
      await queue.createQueue('jobs');
      await queue.stop({ graceful: true, close: false });
      const afterStop = {
        send: await outcome(() => queue.send('jobs', { n: 1 })),
        work: await outcome(() => queue.work('jobs', {}, async () => {})),
      };
      return {
        beforeStart,
        startReturnsQueue: started === queue && startedAgain === queue,
        afterStop,
      };
    });

    assert.deepStrictEqual(observed, {
      beforeStart: {
        createQueue: 'rejected',
        send: 'rejected',
        findJobs: 'rejected',
        work: 'resolved',
      },
      startReturnsQueue: true,
      afterStop: {
        send: 'resolved',
        work: 'Error: Workers are disabled. pg-boss is stopped',
      },
    });
  });

  // No in-process oracle runs pg-boss on its own connection (that needs a
  // Postgres server), so this pins pg-boss 12.35.1's message for it by
  // citation: node_modules/pg-boss/dist/db.js:89.
  it('refuses SQL before start and after a closing stop when it owns its database, and reopens it on restart', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'queue-owned-'));
    const queue = new SqliteJobQueue({
      path: join(dir, 'queue.sqlite'),
      schedule: false,
    });
    try {
      const beforeStart = await outcome(() => queue.createQueue('jobs'));
      await queue.start();
      await queue.createQueue('jobs');
      const whileStarted = await outcome(() => queue.send('jobs', { n: 1 }));
      // A bare stop() closes it: pg-boss's close defaults to true
      // (node_modules/pg-boss/dist/index.js:201).
      await queue.stop();
      const afterClose = await outcome(() => queue.send('jobs', { n: 1 }));
      await queue.start();
      const afterRestart = await outcome(() => queue.send('jobs', { n: 2 }));
      // Stopped without closing, a later closing stop still closes it
      // (node_modules/pg-boss/dist/index.js:206-214).
      await queue.stop({ close: false });
      const afterKeepOpen = await outcome(() => queue.send('jobs', { n: 3 }));
      await queue.stop();
      const afterLateClose = await outcome(() => queue.send('jobs', { n: 4 }));

      const notOpened =
        'AssertionError: Database not opened. Call open() before executing SQL.';
      assert.deepStrictEqual(
        {
          beforeStart,
          whileStarted,
          afterClose,
          afterRestart,
          afterKeepOpen,
          afterLateClose,
        },
        {
          beforeStart: notOpened,
          whileStarted: 'resolved',
          afterClose: notOpened,
          afterRestart: 'resolved',
          afterKeepOpen: 'resolved',
          afterLateClose: notOpened,
        },
      );
    } finally {
      await queue.stop({ graceful: false, close: true });
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('validates updateQueue options the way pg-boss does', async () => {
    // pg-boss's UpdateQueueOptions type omits policy and partition; an
    // untyped caller can still pass them, which is what pg-boss guards.
    const withPolicy = { policy: 'exclusive', retryLimit: 1 };
    const withPartition = { partition: true, retryLimit: 1 };

    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs');
      return {
        policy: await outcome(() => queue.updateQueue('jobs', withPolicy)),
        partition: await outcome(() =>
          queue.updateQueue('jobs', withPartition),
        ),
        empty: await outcome(() => queue.updateQueue('jobs', {})),
        onlyUndefined: await outcome(() =>
          queue.updateQueue('jobs', onlyUndefined()),
        ),
        missingQueue: await outcome(() =>
          queue.updateQueue('missing', { retryLimit: 1 }),
        ),
      };
    });

    assert.deepStrictEqual(observed, {
      policy: 'Error: queue policy cannot be changed after creation',
      partition: 'Error: queue partitioning cannot be changed after creation',
      empty: 'AssertionError: no properties found to update',
      onlyUndefined: 'AssertionError: retryLimit must be an integer >= 0',
      missingQueue: 'resolved',
    });
  });

  it('applies a valid updateQueue to jobs sent afterwards', async () => {
    const job = '00000000-0000-4000-8000-000000000001';

    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('jobs', { retryLimit: 1 });
      await queue.updateQueue('jobs', { retryLimit: 4 });
      const notifyOnly = await outcome(() =>
        queue.updateQueue('jobs', { notify: true }),
      );
      await queue.send('jobs', { n: 1 }, { id: job });
      const [sent] = await queue.findJobs('jobs', { id: job });
      return { notifyOnly, retryLimit: sent?.retryLimit };
    });

    assert.deepStrictEqual(observed, { notifyOnly: 'resolved', retryLimit: 4 });
  });

  it('keeps or clears each queue setting an updateQueue null names, as pg-boss does', async () => {
    const settings = {
      retryLimit: 4,
      retryDelay: 6,
      retryBackoff: true,
      retryDelayMax: 50,
      expireInSeconds: 120,
      retentionSeconds: 500,
      deleteAfterSeconds: 30,
      heartbeatSeconds: 40,
      deadLetter: 'dlq',
      warningQueueSize: 7,
      notify: true,
    };

    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      await queue.createQueue('dlq');
      const results: Record<string, unknown> = {};
      for (const [n, key] of Object.keys(settings).entries()) {
        const name = `q-${key}`;
        await queue.createQueue(name, settings);
        // The null arrives as an untyped caller sends it: as parsed JSON,
        // since most option types do not admit null.
        const update = await outcome(() =>
          queue.updateQueue(name, JSON.parse(`{"${key}":null}`)),
        );
        const id = `00000000-0000-4000-8000-${String(n + 1).padStart(12, '0')}`;
        await queue.send(name, null, { id });
        const [job] = await queue.findJobs(name, { id });
        results[key] = {
          update,
          job: job && {
            retryLimit: job.retryLimit,
            retryDelay: job.retryDelay,
            retryBackoff: job.retryBackoff,
            retryDelayMax: job.retryDelayMax,
            expireInSeconds: job.expireInSeconds,
            retentionSeconds:
              (job.keepUntil.getTime() - job.startAfter.getTime()) / 1000,
            deleteAfterSeconds: job.deleteAfterSeconds,
            heartbeatSeconds: job.heartbeatSeconds,
            deadLetter: job.deadLetter,
          },
        };
      }
      return results;
    });

    // updateQueue COALESCEs every column but three to its stored value, so a
    // null that passes validation (deleteAfterSeconds, warningQueueSize)
    // keeps it; retryDelayMax, heartbeatSeconds and deadLetter take a present
    // key's value, so null clears them
    // (node_modules/pg-boss/dist/plans.js:1155-1177; attorney.js:90-101).
    // warningQueueSize reaches no job, so only its update is observed.
    const { warningQueueSize, notify, ...onJob } = settings;
    const kept = { update: 'resolved', job: onJob };
    const rejected = (message: string) => ({
      update: `AssertionError: ${message}`,
      job: onJob,
    });
    const cleared = (key: string) => ({
      update: 'resolved',
      job: { ...onJob, [key]: null },
    });
    assert.deepStrictEqual(observed, {
      retryLimit: rejected('retryLimit must be an integer >= 0'),
      retryDelay: rejected('retryDelay must be an integer >= 0'),
      retryBackoff: rejected('retryBackoff must be either true or false'),
      retryDelayMax: cleared('retryDelayMax'),
      expireInSeconds: rejected(
        'configuration assert: expireInSeconds must be at least every second',
      ),
      retentionSeconds: rejected(
        'configuration assert: retentionSeconds must be at least every second',
      ),
      deleteAfterSeconds: kept,
      heartbeatSeconds: cleared('heartbeatSeconds'),
      deadLetter: cleared('deadLetter'),
      warningQueueSize: kept,
      notify: rejected('notify must be a boolean'),
    });
  });

  it('validates every queue option the way pg-boss does', async () => {
    // Wrongly typed values arrive the way an untyped caller sends them: as
    // parsed JSON, which the option types cannot reject at compile time.
    const invalid = {
      retryDelay: '{"retryDelay":-1}',
      retryLimit: '{"retryLimit":1.5}',
      retryBackoff: '{"retryBackoff":"yes"}',
      retryDelayMaxWithoutBackoff: '{"retryDelayMax":5}',
      retryDelayMaxNegative: '{"retryBackoff":true,"retryDelayMax":-1}',
      expireInSecondsZero: '{"expireInSeconds":0}',
      expireInSecondsOverDay: '{"expireInSeconds":86401}',
      retentionSeconds: '{"retentionSeconds":0}',
      deleteAfterSeconds: '{"deleteAfterSeconds":-1}',
      heartbeatSeconds: '{"heartbeatSeconds":5}',
      notify: '{"notify":"yes"}',
      deadLetterType: '{"deadLetter":5}',
      deadLetterName: '{"deadLetter":"bad name!"}',
    };

    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      const results: Record<string, string> = {};
      for (const [label, config] of Object.entries(invalid)) {
        results[label] = await outcome(() =>
          queue.createQueue(`q-${label}`, JSON.parse(config)),
        );
      }
      return results;
    });

    for (const [label, result] of Object.entries(observed)) {
      assert.match(result, /^AssertionError: /, label);
    }
  });

  it('rejects invalid queue names on every method the way pg-boss does', async () => {
    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      const byMethod = async (name: string) => ({
        send: await outcome(() => queue.send(name, { n: 1 })),
        work: await outcome(() => queue.work(name, {}, async () => {})),
        findJobs: await outcome(() => queue.findJobs(name)),
        cancel: await outcome(() =>
          queue.cancel(name, '00000000-0000-4000-8000-000000000001'),
        ),
        fail: await outcome(() =>
          queue.fail(name, '00000000-0000-4000-8000-000000000001'),
        ),
        deleteQueue: await outcome(() => queue.deleteQueue(name)),
        schedule: await outcome(() => queue.schedule(name, '* * * * *')),
        unschedule: await outcome(() => queue.unschedule(name)),
      });
      return {
        empty: await byMethod(''),
        invalid: await byMethod('bad name!'),
      };
    });

    const invalid =
      'AssertionError: Name can only contain alphanumeric characters, underscores, hyphens, periods, or forward slashes';
    assert.deepStrictEqual(observed, {
      empty: {
        send: 'AssertionError: boss requires all jobs to have a queue name',
        work: 'AssertionError: queue name is required',
        findJobs: 'AssertionError: Name is required',
        cancel: 'AssertionError: Name is required',
        fail: 'AssertionError: Name is required',
        deleteQueue: 'AssertionError: Name is required',
        schedule: 'AssertionError: boss requires all jobs to have a queue name',
        unschedule: 'resolved',
      },
      invalid: {
        send: invalid,
        work: 'resolved',
        findJobs: invalid,
        cancel: invalid,
        fail: invalid,
        deleteQueue: invalid,
        schedule: 'error: Queue bad name! not found (23503)',
        unschedule: 'resolved',
      },
    });
  });

  it('validates createQueue and deleteQueue the way pg-boss does', async () => {
    const job = '00000000-0000-4000-8000-000000000001';
    const partitioned = '00000000-0000-4000-8000-000000000002';
    const withBogusPolicy = { policy: 'bogus' };

    const observed = await Parity.assertSame(async ({ queue }) => {
      await queue.start();
      const results = {
        invalidName: await outcome(() => queue.createQueue('bad name!')),
        invalidPolicy: await outcome(() =>
          queue.createQueue('a', withBogusPolicy),
        ),
        invalidRetryLimit: await outcome(() =>
          queue.createQueue('b', { retryLimit: -1 }),
        ),
        deadLetterItself: await outcome(() =>
          queue.createQueue('c', { deadLetter: 'c' }),
        ),
        deadLetterMissing: await outcome(() =>
          queue.createQueue('d', { deadLetter: 'nowhere' }),
        ),
        partitioned: await outcome(() =>
          queue.createQueue('e', { partition: true }),
        ),
        createdTwice: await outcome(async () => {
          await queue.createQueue('f', { retryLimit: 1 });
          await queue.createQueue('f', { retryLimit: 5 });
        }),
        deleteMissing: await outcome(() => queue.deleteQueue('nowhere')),
        sendAfterDelete: await outcome(async () => {
          await queue.createQueue('g');
          await queue.deleteQueue('g');
          await queue.send('g', { n: 1 });
        }),
      };
      await queue.send('f', { n: 1 }, { id: job });
      const [created] = await queue.findJobs('f', { id: job });
      const partitionedJob = await queue.send(
        'e',
        { n: 1 },
        { id: partitioned },
      );
      return {
        ...results,
        keptFirstOptions: created?.retryLimit,
        partitionedQueueTakesJobs: partitionedJob,
      };
    });

    assert.deepStrictEqual(observed, {
      invalidName:
        'AssertionError: Name can only contain alphanumeric characters, underscores, hyphens, periods, or forward slashes',
      invalidPolicy: 'AssertionError: bogus is not a valid queue policy',
      invalidRetryLimit: 'AssertionError: retryLimit must be an integer >= 0',
      deadLetterItself: 'AssertionError: deadLetter cannot be itself',
      deadLetterMissing: 'Error: Queue nowhere does not exist',
      partitioned: 'resolved',
      createdTwice: 'resolved',
      deleteMissing: 'resolved',
      sendAfterDelete: 'Error: Queue g does not exist',
      keptFirstOptions: 1,
      partitionedQueueTakesJobs: partitioned,
    });
  });
});
