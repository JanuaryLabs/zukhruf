import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { Mutex, SqliteStore } from '@zukhruf/mutex';

import {
  FileFlightRecords,
  FlightFailedError,
  FlightInterruptedError,
  type FlightRecords,
  SharedFlight,
} from './index.ts';
import { startCaller } from './testing/caller-process.ts';

const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new TypeError('A report is text.');
  return value;
};

test(
  'a joiner that comes after a holder crashed, before the next holder begins its flight, gets the value of that next flight',
  { timeout: 30_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const records = join(directory.path, 'records');
    const locks = join(directory.path, 'locks');
    {
      await using crashed = startCaller(records, locks);
      await crashed.heard('flying');
      await crashed.kill();
    }
    // The next holder has the key, but its records begin its flight only on a sign.
    const files = new FileFlightRecords(records);
    const beginning = Promise.withResolvers<void>();
    const begin = Promise.withResolvers<void>();
    const slowToBegin: FlightRecords = {
      begin: async (key) => {
        beginning.resolve();
        await begin.promise;
        return files.begin(key);
      },
      finish: (key, id, outcome) => files.finish(key, id, outcome),
      latest: (key) => files.latest(key),
      outcome: (key, id) => files.outcome(key, id),
    };
    const next = new SharedFlight({
      mutex: new Mutex(new SqliteStore(locks)),
      records: slowToBegin,
      parse: text,
      pollInterval: 10,
    });
    try {
      const leading = next.run('sync', async () => 'report of the next flight');
      await beginning.promise;
      await using joiner = startCaller(records, locks);
      await joiner.heard('joined');

      begin.resolve();
      const led = await leading;
      const landed = await joiner.heard('landed');

      assert.deepEqual(led, {
        value: 'report of the next flight',
        joined: false,
      });
      assert.deepEqual(landed, {
        type: 'landed',
        value: 'report of the next flight',
        joined: true,
      });
    } finally {
      begin.resolve();
    }
  },
);

test(
  'two processes on one records directory: the work runs once, and both callers of the other process get its value',
  { timeout: 30_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const records = join(directory.path, 'records');
    const locks = join(directory.path, 'locks');
    await using leader = startCaller(records, locks);
    await leader.heard('flying');
    const flights = new SharedFlight({
      mutex: new Mutex(new SqliteStore(locks)),
      records: new FileFlightRecords(records),
      parse: text,
      pollInterval: 10,
    });
    let executions = 0;
    const work = async () => {
      executions++;
      return 'report of this process';
    };
    const joins = [0, 0];
    const firstJoined = Promise.withResolvers<void>();

    const first = flights.run('sync', work, {
      onJoin: () => {
        joins[0]!++;
        firstJoined.resolve();
      },
    });
    const second = flights.run('sync', work, { onJoin: () => joins[1]!++ });
    await firstJoined.promise;
    leader.order({ type: 'land', value: 'report of the leader' });

    assert.deepEqual(await Promise.all([first, second]), [
      { value: 'report of the leader', joined: true },
      { value: 'report of the leader', joined: true },
    ]);
    assert.deepEqual(await leader.heard('landed'), {
      type: 'landed',
      value: 'report of the leader',
      joined: false,
    });
    assert.equal(executions, 0);
    assert.deepEqual(joins, [1, 1]);
  },
);

test(
  'a joiner in another process gets FlightFailedError with the name, message and code of the error',
  { timeout: 30_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const records = join(directory.path, 'records');
    const locks = join(directory.path, 'locks');
    await using leader = startCaller(records, locks);
    await leader.heard('flying');
    const flights = new SharedFlight({
      mutex: new Mutex(new SqliteStore(locks)),
      records: new FileFlightRecords(records),
      parse: text,
      pollInterval: 10,
    });
    const joined = Promise.withResolvers<void>();
    const joining = flights.run('sync', async () => 'report of this process', {
      onJoin: () => joined.resolve(),
    });
    await joined.promise;

    leader.order({
      type: 'crash',
      name: 'SyncError',
      message: 'disk full',
      code: 'ENOSPC',
    });
    const error = await joining.then(
      () => undefined,
      (reason: unknown) => reason,
    );

    assert.ok(error instanceof FlightFailedError, String(error));
    assert.equal(error.key, 'sync');
    assert.deepEqual(error.failure, {
      name: 'SyncError',
      message: 'disk full',
      code: 'ENOSPC',
    });
    assert.deepEqual(await leader.heard('failed'), {
      type: 'failed',
      name: 'SyncError',
      message: 'disk full',
    });
  },
);

test(
  'a joiner whose holder crashes in the middle of the flight gets FlightInterruptedError, and the next run leads a new flight',
  { timeout: 30_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const records = join(directory.path, 'records');
    const locks = join(directory.path, 'locks');
    await using leader = startCaller(records, locks);
    await leader.heard('flying');
    const flights = new SharedFlight({
      mutex: new Mutex(new SqliteStore(locks)),
      records: new FileFlightRecords(records),
      parse: text,
      pollInterval: 10,
    });
    const joined = Promise.withResolvers<void>();
    const joining = flights.run('sync', async () => 'report of this process', {
      onJoin: () => joined.resolve(),
    });
    await joined.promise;
    await delay(50); // the joiner looks at the holder while it runs

    await leader.kill();
    const error = await joining.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    const next = await flights.run(
      'sync',
      async () => 'report of the next flight',
    );

    assert.ok(error instanceof FlightInterruptedError, String(error));
    assert.equal(error.key, 'sync');
    assert.deepEqual(next, {
      value: 'report of the next flight',
      joined: false,
    });
  },
);
