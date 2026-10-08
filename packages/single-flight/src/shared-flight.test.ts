import assert from 'node:assert/strict';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  LockLostError,
  type LockStore,
  MemoryStore,
  Modes,
  Mutex,
} from '@zukhruf/mutex';

import {
  FileFlightRecords,
  FlightFailedError,
  FlightInterruptedError,
  FlightOutcomeLostError,
  type FlightRecords,
  SharedFlight,
} from './index.ts';

const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new TypeError('A report is text.');
  return value;
};

test(
  'a joiner gets the value of its flight while the key stays held after the flight ended',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    // One store shared by two SharedFlight objects: each one stands for a process.
    const store = new MemoryStore();
    const flightsOf = () =>
      new SharedFlight({
        mutex: new Mutex(store),
        records: new FileFlightRecords(directory.path),
        parse: text,
        pollInterval: 10,
      });
    const [leader, joiner] = [flightsOf(), flightsOf()];
    const nextHolder = new Mutex(store);
    const flying = Promise.withResolvers<void>();
    const built = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    try {
      const led = leader.run('sync', async () => {
        flying.resolve();
        await built.promise;
        return 'report 1';
      });
      await flying.promise;
      const joining = joiner.run('sync', async () => 'report of the joiner', {
        onJoin: () => joined.resolve(),
      });
      await joined.promise;
      // It waits in line, so the key passes to it the moment the flight ends.
      const next = nextHolder.acquire('sync', () => released.promise);

      built.resolve();
      const result = await joining;
      const heldWhenTheJoinerGotIt = await nextHolder.isHeld('sync');
      released.resolve();
      await Promise.all([led, next]);

      assert.deepEqual(result, { value: 'report 1', joined: true });
      assert.equal(heldWhenTheJoinerGotIt, true);
    } finally {
      built.resolve();
      released.resolve();
    }
  },
);

test(
  'a store that is busy while nobody holds the key makes the caller lead, not join',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const memory = new MemoryStore();
    let refusals = 3;
    // Busy with no holder, as LockCoordinator is during its grace window.
    const busyAtFirst: LockStore = {
      acquire: (key, options) => memory.acquire(key, options),
      tryAcquire: async (key) =>
        refusals-- > 0 ? undefined : memory.tryAcquire(key),
      isHeld: (key) => memory.isHeld(key),
    };
    const flights = new SharedFlight({
      mutex: new Mutex(busyAtFirst),
      records: new FileFlightRecords(directory.path),
      parse: text,
      pollInterval: 10,
    });
    let joins = 0;

    const result = await flights.run('sync', async () => 'report', {
      onJoin: () => joins++,
    });

    assert.deepEqual(result, { value: 'report', joined: false });
    assert.equal(joins, 0);
  },
);

test(
  'a caller that finds a running record but never sees its holder leads a new flight',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const records = new FileFlightRecords(directory.path);
    // A leader whose records refused its outcome leaves its flight running.
    const refusesOutcomes: FlightRecords = {
      begin: (key) => records.begin(key),
      finish: async () => {
        throw new Error('disk full');
      },
      latest: (key) => records.latest(key),
      outcome: (key, id) => records.outcome(key, id),
    };
    const stopped = new SharedFlight({
      mutex: new Mutex(new MemoryStore()),
      records: refusesOutcomes,
      parse: text,
      pollInterval: 10,
    });
    await assert.rejects(stopped.run('sync', async () => 'lost report'));
    const memory = new MemoryStore();
    let refusals = 1;
    const busyOnce: LockStore = {
      acquire: (key, options) => memory.acquire(key, options),
      tryAcquire: async (key) =>
        refusals-- > 0 ? undefined : memory.tryAcquire(key),
      isHeld: (key) => memory.isHeld(key),
    };
    const flights = new SharedFlight({
      mutex: new Mutex(busyOnce),
      records,
      parse: text,
      pollInterval: 10,
    });

    const result = await flights.run('sync', async () => 'fresh report');

    assert.deepEqual(result, { value: 'fresh report', joined: false });
  },
);

test(
  'a joiner never takes the key: a caller that skips if busy gets it right after the flight ends',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const store = new MemoryStore();
    const flightsOf = () =>
      new SharedFlight({
        mutex: new Mutex(store),
        records: new FileFlightRecords(directory.path),
        parse: text,
        pollInterval: 10,
      });
    const [leader, joiner] = [flightsOf(), flightsOf()];
    const flying = Promise.withResolvers<void>();
    const built = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    try {
      const led = leader.run('sync', async () => {
        flying.resolve();
        await built.promise;
        return 'report';
      });
      await flying.promise;
      const joining = joiner.run('sync', async () => 'report of the joiner', {
        onJoin: () => joined.resolve(),
      });
      await joined.promise;
      built.resolve();
      await led;

      const third = await new Mutex(store).acquire(
        'sync',
        async () => 'third',
        { mode: Modes.skipIfBusy() },
      );
      await joining;

      assert.deepEqual(third, { acquired: true, value: 'third' });
    } finally {
      built.resolve();
    }
  },
);

test(
  'when the records refuse the outcome, the leader, a caller that joined it here and a joiner elsewhere all reject',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const store = new MemoryStore();
    const records = new FileFlightRecords(directory.path);
    const refusal = new Error('disk full');
    const refusesOutcomes: FlightRecords = {
      begin: (key) => records.begin(key),
      finish: async () => {
        throw refusal;
      },
      latest: (key) => records.latest(key),
      outcome: (key, id) => records.outcome(key, id),
    };
    const leader = new SharedFlight({
      mutex: new Mutex(store),
      records: refusesOutcomes,
      parse: text,
      pollInterval: 10,
    });
    const sawTheHolder = Promise.withResolvers<void>();
    let reads = 0;
    // A joiner reads the flight record again only after it saw the holder run
    // the flight, so the second read shows that it saw the holder alive.
    const watched: FlightRecords = {
      begin: (key) => records.begin(key),
      finish: (key, id, outcome) => records.finish(key, id, outcome),
      latest: (key) => records.latest(key),
      outcome: (key, id) => {
        if (++reads === 2) sawTheHolder.resolve();
        return records.outcome(key, id);
      },
    };
    const joiner = new SharedFlight({
      mutex: new Mutex(store),
      records: watched,
      parse: text,
      pollInterval: 10,
    });
    const flying = Promise.withResolvers<void>();
    const built = Promise.withResolvers<void>();
    try {
      const led = leader.run('sync', async () => {
        flying.resolve();
        await built.promise;
        return 'report';
      });
      await flying.promise;
      const joinedHere = leader.run('sync', async () => 'second report');
      const joinedElsewhere = joiner.run('sync', async () => 'third report');
      await sawTheHolder.promise;

      built.resolve();

      await Promise.all([
        assert.rejects(led, (error) => error === refusal),
        assert.rejects(joinedHere, (error) => error === refusal),
        assert.rejects(joinedElsewhere, FlightInterruptedError),
      ]);
    } finally {
      built.resolve();
    }
  },
);

test(
  'the caller that started a flight cancels: it rejects with its reason, and the flight runs to its end for the caller that joined it',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const records = new FileFlightRecords(directory.path);
    const flights = new SharedFlight({
      mutex: new Mutex(new MemoryStore()),
      records,
      parse: text,
      pollInterval: 10,
    });
    const cancel = new AbortController();
    const pressedCtrlC = new Error('The user pressed Ctrl+C.');
    const flying = Promise.withResolvers<void>();
    const built = Promise.withResolvers<void>();
    try {
      const first = flights.run(
        'sync',
        async () => {
          flying.resolve();
          await built.promise;
          return 'report';
        },
        { signal: cancel.signal },
      );
      await flying.promise;
      const second = flights.run('sync', async () => 'second report');

      cancel.abort(pressedCtrlC);
      await assert.rejects(first, (error) => error === pressedCtrlC);
      built.resolve();

      assert.deepEqual(await second, { value: 'report', joined: true });
      assert.equal((await records.latest('sync'))?.status, 'succeeded');
    } finally {
      built.resolve();
    }
  },
);

test(
  'a joiner cancels: it rejects with its reason, and the caller that shares its wait and the leader still get the value',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const store = new MemoryStore();
    const flightsOf = () =>
      new SharedFlight({
        mutex: new Mutex(store),
        records: new FileFlightRecords(directory.path),
        parse: text,
        pollInterval: 10,
      });
    const [leader, joiner] = [flightsOf(), flightsOf()];
    const cancel = new AbortController();
    const tooLong = new Error('The user waited long enough.');
    const flying = Promise.withResolvers<void>();
    const built = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    try {
      const led = leader.run('sync', async () => {
        flying.resolve();
        await built.promise;
        return 'report';
      });
      await flying.promise;
      const impatient = joiner.run('sync', async () => 'second report', {
        signal: cancel.signal,
        onJoin: () => joined.resolve(),
      });
      await joined.promise;
      const patient = joiner.run('sync', async () => 'third report');

      cancel.abort(tooLong);
      await assert.rejects(impatient, (error) => error === tooLong);
      built.resolve();

      assert.deepEqual(await led, { value: 'report', joined: false });
      assert.deepEqual(await patient, { value: 'report', joined: true });
    } finally {
      built.resolve();
    }
  },
);

test(
  'the leader and a joiner get the value in one shape: a Date arrives as a Date, and what parse drops is gone for both',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const store = new MemoryStore();
    // Keeps only the fields of a report, as a schema does.
    const parseReport = (value: unknown) => {
      if (
        typeof value !== 'object' ||
        value === null ||
        !('builtAt' in value) ||
        !('rows' in value) ||
        typeof value.builtAt !== 'string' ||
        typeof value.rows !== 'number'
      )
        throw new TypeError('Not a report.');
      return { builtAt: new Date(value.builtAt), rows: value.rows };
    };
    const flightsOf = () =>
      new SharedFlight({
        mutex: new Mutex(store),
        records: new FileFlightRecords(directory.path),
        parse: parseReport,
        pollInterval: 10,
      });
    const [leader, joiner] = [flightsOf(), flightsOf()];
    const flying = Promise.withResolvers<void>();
    const built = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    try {
      const led = leader.run('report:daily', async () => {
        flying.resolve();
        await built.promise;
        return {
          builtAt: new Date('2026-10-08T10:00:00.000Z'),
          rows: 3,
          source: 'warehouse',
        };
      });
      await flying.promise;
      const joining = joiner.run(
        'report:daily',
        async () => ({ builtAt: new Date(), rows: 0 }),
        { onJoin: () => joined.resolve() },
      );
      await joined.promise;

      built.resolve();

      const report = { builtAt: new Date('2026-10-08T10:00:00.000Z'), rows: 3 };
      assert.deepEqual(await led, { value: report, joined: false });
      assert.deepEqual(await joining, { value: report, joined: true });
    } finally {
      built.resolve();
    }
  },
);

test(
  'callers in the process of the leader get the original error of a flight that failed',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const flights = new SharedFlight({
      mutex: new Mutex(new MemoryStore()),
      records: new FileFlightRecords(directory.path),
      parse: text,
      pollInterval: 10,
    });
    const failure = Object.assign(new Error('disk full'), {
      name: 'SyncError',
    });
    const flying = Promise.withResolvers<void>();
    const built = Promise.withResolvers<void>();
    try {
      const led = flights.run('sync', async () => {
        flying.resolve();
        await built.promise;
        throw failure;
      });
      await flying.promise;
      const joinedHere = flights.run('sync', async () => 'second report');

      built.resolve();

      await Promise.all([
        assert.rejects(led, (error) => error === failure),
        assert.rejects(joinedHere, (error) => error === failure),
      ]);
    } finally {
      built.resolve();
    }
  },
);

test(
  'a flight that throws a value that is not an error reaches a joiner elsewhere as FlightFailedError with the text of the value',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const store = new MemoryStore();
    const flightsOf = () =>
      new SharedFlight({
        mutex: new Mutex(store),
        records: new FileFlightRecords(directory.path),
        parse: text,
        pollInterval: 10,
      });
    const [leader, joiner] = [flightsOf(), flightsOf()];
    const flying = Promise.withResolvers<void>();
    const built = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    try {
      const led = leader.run('sync', async () => {
        flying.resolve();
        await built.promise;
        return Promise.reject('disk full');
      });
      await flying.promise;
      const joining = joiner.run('sync', async () => 'second report', {
        onJoin: () => joined.resolve(),
      });
      await joined.promise;

      built.resolve();
      const [, error] = await Promise.all([
        assert.rejects(led, (reason) => reason === 'disk full'),
        joining.then(
          () => undefined,
          (reason: unknown) => reason,
        ),
      ]);

      assert.ok(error instanceof FlightFailedError, String(error));
      assert.deepEqual(error.failure, { name: 'Error', message: 'disk full' });
    } finally {
      built.resolve();
    }
  },
);

test(
  'a value that JSON cannot carry fails the flight: the leader rejects, and a joiner elsewhere gets FlightFailedError',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const store = new MemoryStore();
    const flightsOf = () =>
      new SharedFlight({
        mutex: new Mutex(store),
        records: new FileFlightRecords(directory.path),
        parse: (value: unknown) => value,
        pollInterval: 10,
      });
    const [leader, joiner] = [flightsOf(), flightsOf()];
    const flying = Promise.withResolvers<void>();
    const built = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    try {
      const led = leader.run('sync', async () => {
        flying.resolve();
        await built.promise;
        return { rows: 3n };
      });
      await flying.promise;
      const joining = joiner.run('sync', async () => ({ rows: 0 }), {
        onJoin: () => joined.resolve(),
      });
      await joined.promise;

      built.resolve();
      const [, error] = await Promise.all([
        assert.rejects(led, TypeError),
        joining.then(
          () => undefined,
          (reason: unknown) => reason,
        ),
      ]);

      assert.ok(error instanceof FlightFailedError, String(error));
      assert.equal(error.failure.name, 'TypeError');
    } finally {
      built.resolve();
    }
  },
);

test(
  'when the only caller in a process cancels while the key is busy, the process stops looking and never leads a flight for it',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const store = new MemoryStore();
    // A holder that runs no flight, so there is no record to join.
    const holder = new Mutex(store);
    const released = Promise.withResolvers<void>();
    const records = new FileFlightRecords(directory.path);
    let reads = 0;
    // Counts what the process reads, as a database would count its queries.
    const counted: FlightRecords = {
      begin: (key) => records.begin(key),
      finish: (key, id, outcome) => records.finish(key, id, outcome),
      latest: (key) => {
        reads++;
        return records.latest(key);
      },
      outcome: (key, id) => {
        reads++;
        return records.outcome(key, id);
      },
    };
    const flights = new SharedFlight({
      mutex: new Mutex(store),
      records: counted,
      parse: text,
      pollInterval: 10,
    });
    let executions = 0;
    const cancel = new AbortController();
    try {
      const held = holder.acquire('sync', () => released.promise);
      const call = flights.run(
        'sync',
        async () => {
          executions++;
          return 'report';
        },
        { signal: cancel.signal },
      );
      await delay(50); // the caller looks for a flight to join

      cancel.abort();
      await assert.rejects(call, (error) => error === cancel.signal.reason);
      const readsWhenItLeft = reads;
      await delay(100); // ten looks while the key is still busy
      const readsAfter = reads - readsWhenItLeft;
      released.resolve();
      await held;
      await delay(100); // ten looks: a search that went on would take the free key

      assert.equal(readsAfter, 0);
      assert.equal(executions, 0);
    } finally {
      released.resolve();
    }
  },
);

test(
  'a flight whose lease was lost ends interrupted: the leader rejects with the reason of the lease, and a joiner elsewhere gets FlightInterruptedError',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const memory = new MemoryStore();
    const loss = new AbortController();
    // Loses a key while its holder runs, as SocketStore can after a failover.
    const losing: LockStore = {
      acquire: (key, options) => memory.acquire(key, options),
      tryAcquire: async (key) => {
        const handle = await memory.tryAcquire(key);
        return (
          handle && {
            token: handle.token,
            signal: loss.signal,
            [Symbol.asyncDispose]: () => handle[Symbol.asyncDispose](),
          }
        );
      },
      isHeld: (key) => memory.isHeld(key),
    };
    const flightsOf = () =>
      new SharedFlight({
        mutex: new Mutex(losing),
        records: new FileFlightRecords(directory.path),
        parse: text,
        pollInterval: 10,
      });
    const [leader, joiner] = [flightsOf(), flightsOf()];
    const lost = new LockLostError('sync');
    const flying = Promise.withResolvers<void>();
    const built = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    try {
      const led = leader.run('sync', async () => {
        flying.resolve();
        await built.promise;
        return 'report';
      });
      await flying.promise;
      const joining = joiner.run('sync', async () => 'second report', {
        onJoin: () => joined.resolve(),
      });
      await joined.promise;

      loss.abort(lost);
      built.resolve();

      await Promise.all([
        assert.rejects(led, (error) => error === lost),
        assert.rejects(joining, FlightInterruptedError),
      ]);
    } finally {
      built.resolve();
    }
  },
);

test(
  'a joiner whose flight record was removed before it read the outcome gets FlightOutcomeLostError',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const store = new MemoryStore();
    // The leader keeps no outcome once a newer flight of the key began.
    const leader = new SharedFlight({
      mutex: new Mutex(store),
      records: new FileFlightRecords(directory.path, { keepFor: 0 }),
      parse: text,
      pollInterval: 10,
    });
    const records = new FileFlightRecords(directory.path);
    const newerBegan = Promise.withResolvers<void>();
    // The joiner reads the outcome of its flight only after a newer flight began.
    const slowToRead: FlightRecords = {
      begin: (key) => records.begin(key),
      finish: (key, id, outcome) => records.finish(key, id, outcome),
      latest: (key) => records.latest(key),
      outcome: async (key, id) => {
        await newerBegan.promise;
        return records.outcome(key, id);
      },
    };
    const joiner = new SharedFlight({
      mutex: new Mutex(store),
      records: slowToRead,
      parse: text,
      pollInterval: 10,
    });
    const flying = Promise.withResolvers<void>();
    const built = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    const nextFlying = Promise.withResolvers<void>();
    const nextBuilt = Promise.withResolvers<void>();
    try {
      const led = leader.run('sync', async () => {
        flying.resolve();
        await built.promise;
        return 'report';
      });
      await flying.promise;
      const joining = joiner.run('sync', async () => 'second report', {
        onJoin: () => joined.resolve(),
      });
      await joined.promise;

      built.resolve();
      await led;
      const next = leader.run('sync', async () => {
        nextFlying.resolve();
        await nextBuilt.promise;
        return 'next report';
      });
      await nextFlying.promise;
      newerBegan.resolve();

      await assert.rejects(joining, FlightOutcomeLostError);
      nextBuilt.resolve();
      await next;
    } finally {
      built.resolve();
      newerBegan.resolve();
      nextBuilt.resolve();
    }
  },
);

test('a poll interval or a time to keep outcomes that is not a duration is refused when the object is built', () => {
  const durations = [-1, Number.NaN, Number.POSITIVE_INFINITY];

  for (const duration of durations) {
    assert.throws(
      () =>
        new SharedFlight({
          mutex: new Mutex(new MemoryStore()),
          records: new FileFlightRecords(tmpdir()),
          parse: text,
          pollInterval: duration,
        }),
      RangeError,
    );
    assert.throws(
      () => new FileFlightRecords(tmpdir(), { keepFor: duration }),
      RangeError,
    );
  }
});

test(
  'a caller that cancels while its process reads the records, before it tries the key, never runs the work',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const records = new FileFlightRecords(directory.path);
    const reading = Promise.withResolvers<void>();
    const read = Promise.withResolvers<void>();
    // The first read of the records waits, as a slow disk or database does.
    const slowToRead: FlightRecords = {
      begin: (key) => records.begin(key),
      finish: (key, id, outcome) => records.finish(key, id, outcome),
      latest: async (key) => {
        reading.resolve();
        await read.promise;
        return records.latest(key);
      },
      outcome: (key, id) => records.outcome(key, id),
    };
    const flights = new SharedFlight({
      mutex: new Mutex(new MemoryStore()),
      records: slowToRead,
      parse: text,
      pollInterval: 10,
    });
    let executions = 0;
    const cancel = new AbortController();
    try {
      const call = flights.run(
        'sync',
        async () => {
          executions++;
          return 'report';
        },
        { signal: cancel.signal },
      );
      await reading.promise;

      cancel.abort();
      await assert.rejects(call, (error) => error === cancel.signal.reason);
      read.resolve();
      await delay(50); // the read ends, and a process that went on would take the free key

      assert.equal(executions, 0);
    } finally {
      read.resolve();
    }
  },
);

test(
  'the only caller of a joined flight cancels: its process stops reading the flight record',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const store = new MemoryStore();
    const records = new FileFlightRecords(directory.path);
    let reads = 0;
    // Counts what the joining process reads, as a database would count its queries.
    const counted: FlightRecords = {
      begin: (key) => records.begin(key),
      finish: (key, id, outcome) => records.finish(key, id, outcome),
      latest: (key) => {
        reads++;
        return records.latest(key);
      },
      outcome: (key, id) => {
        reads++;
        return records.outcome(key, id);
      },
    };
    const leader = new SharedFlight({
      mutex: new Mutex(store),
      records,
      parse: text,
      pollInterval: 10,
    });
    const joiner = new SharedFlight({
      mutex: new Mutex(store),
      records: counted,
      parse: text,
      pollInterval: 10,
    });
    const cancel = new AbortController();
    const flying = Promise.withResolvers<void>();
    const built = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    try {
      const led = leader.run('sync', async () => {
        flying.resolve();
        await built.promise;
        return 'report';
      });
      await flying.promise;
      const joining = joiner.run('sync', async () => 'second report', {
        signal: cancel.signal,
        onJoin: () => joined.resolve(),
      });
      await joined.promise;
      await delay(50); // the joiner reads the flight record while it runs

      cancel.abort();
      await assert.rejects(joining, (error) => error === cancel.signal.reason);
      const readsWhenItLeft = reads;
      await delay(100); // ten poll intervals
      const readsAfter = reads - readsWhenItLeft;
      built.resolve();
      await led;

      assert.equal(readsAfter, 0);
    } finally {
      built.resolve();
    }
  },
);

test(
  'a flight that this process leads runs to its end when all its callers cancel, for the joiners in other processes',
  { timeout: 10_000 },
  async () => {
    await using directory = await mkdtempDisposable(join(tmpdir(), 'flights-'));
    const store = new MemoryStore();
    const records = new FileFlightRecords(directory.path);
    const flightsOf = () =>
      new SharedFlight({
        mutex: new Mutex(store),
        records,
        parse: text,
        pollInterval: 10,
      });
    const [leader, joiner] = [flightsOf(), flightsOf()];
    const cancel = new AbortController();
    const flying = Promise.withResolvers<void>();
    const built = Promise.withResolvers<void>();
    const joined = Promise.withResolvers<void>();
    try {
      const led = leader.run(
        'sync',
        async () => {
          flying.resolve();
          await built.promise;
          return 'report';
        },
        { signal: cancel.signal },
      );
      await flying.promise;
      const joining = joiner.run('sync', async () => 'second report', {
        onJoin: () => joined.resolve(),
      });
      await joined.promise;

      cancel.abort();
      await assert.rejects(led, (error) => error === cancel.signal.reason);
      built.resolve();

      assert.deepEqual(await joining, { value: 'report', joined: true });
      assert.equal((await records.latest('sync'))?.status, 'succeeded');
    } finally {
      built.resolve();
    }
  },
);
