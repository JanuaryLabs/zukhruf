import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, test } from 'node:test';
import { promisify } from 'node:util';

import { createClock } from '@sinonjs/fake-timers';

import {
  ChangeWatcher,
  type Check,
  Collector,
  Gauge,
  Group,
  Latch,
  type Outcome,
  Period,
  type Primitive,
  type Sample,
} from './index.ts';

const execFileAsync = promisify(execFile);

// A gauge whose value the test sets, and that counts its reads.
class Setting extends Gauge<Primitive> {
  current: Primitive;
  reads = 0;
  failure: Error | undefined;
  constructor(value: Primitive) {
    super();
    this.current = value;
  }
  protected async read() {
    this.reads++;
    if (this.failure !== undefined) throw this.failure;
    return this.current;
  }
}

// One read for every key, as one query over every table.
class Table extends Collector<string> {
  rows = new Map<string, Sample>();
  reads = 0;
  protected async collect() {
    this.reads++;
    return new Map(this.rows);
  }
}

const states = <G>(
  outcomes: ReadonlyMap<G, Outcome> | undefined,
  gauges: readonly G[],
) => gauges.map((gauge) => outcomes?.get(gauge)?.state);

describe('ChangeWatcher', () => {
  test('the first check reads at once and every gauge changed, a later check tells each gauge changed or unchanged, and a check with no change has every gauge unchanged', async (t) => {
    // Arrange
    const clock = createClock();
    const books = new Setting(1);
    const notes = new Setting('a');
    const checks = new ChangeWatcher([books, notes], {
      interval: 5,
      timeout: 5,
      clock,
    }).watch(new AbortController().signal);

    // Act
    const first = await checks.next();
    const timersAfterCheck = clock.countTimers();
    notes.current = 'b';
    const second = checks.next();
    await t.waitFor(() => assert.equal(clock.countTimers(), 1));
    await clock.tickAsync(5);
    const changedNotes = await second;
    const third = checks.next();
    await t.waitFor(() => assert.equal(clock.countTimers(), 1));
    await clock.tickAsync(5);
    const noChange = await third;

    // Assert
    assert.equal(clock.now, 10, 'The first check must read before any wait');
    assert.equal(
      timersAfterCheck,
      0,
      'The timer of the timeout must end with the check',
    );
    assert.deepEqual(states(first.value ?? undefined, [books, notes]), [
      'changed',
      'changed',
    ]);
    assert.deepEqual(states(changedNotes.value ?? undefined, [books, notes]), [
      'unchanged',
      'changed',
    ]);
    assert.deepEqual(states(noChange.value ?? undefined, [books, notes]), [
      'unchanged',
      'unchanged',
    ]);
  });

  test('a collector reads one time in each check however many of its keys are watched, and a key that appears or disappears changed', async (t) => {
    // Arrange
    const clock = createClock();
    const table = new Table();
    table.rows.set('notes', 1);
    const notes = table.gauge('notes');
    const other = table.gauge('other');
    const checks = new ChangeWatcher([notes, other], {
      interval: 5,
      timeout: 5,
      clock,
    }).watch(new AbortController().signal);
    const next = async () => {
      const result = checks.next();
      await t.waitFor(() => assert.equal(clock.countTimers(), 1));
      await clock.tickAsync(5);
      return (await result).value ?? undefined;
    };

    // Act
    await checks.next();
    table.rows.set('other', 1);
    const appeared = await next();
    table.rows.delete('notes');
    const disappeared = await next();

    // Assert
    assert.equal(
      table.reads,
      3,
      'One query must serve every watched key of a check',
    );
    assert.deepEqual(states(appeared, [notes, other]), [
      'unchanged',
      'changed',
    ]);
    assert.deepEqual(
      states(disappeared, [notes, other]),
      ['changed', 'unchanged'],
      'A table dropped since the previous check must wake its consumer',
    );
  });

  test('a failed read fails only its gauge, the other gauges go on, and after it recovers it changed only if its value differs from its last value', async (t) => {
    // Arrange
    const clock = createClock();
    const locked = new Setting(1);
    const other = new Setting(1);
    const failure = new Error('database is locked');
    const checks = new ChangeWatcher([locked, other], {
      interval: 5,
      timeout: 5,
      clock,
    }).watch(new AbortController().signal);
    const next = async () => {
      const result = checks.next();
      await t.waitFor(() => assert.equal(clock.countTimers(), 1));
      await clock.tickAsync(5);
      return (await result).value ?? undefined;
    };

    // Act
    await checks.next();
    locked.failure = failure;
    other.current = 2;
    const failed = await next();
    locked.failure = undefined;
    const recovered = await next();
    locked.current = 3;
    const moved = await next();

    // Assert
    assert.deepEqual(failed?.get(locked), {
      state: 'failed',
      error: failure,
    });
    assert.equal(
      failed?.get(other)?.state,
      'changed',
      'A failed gauge must not hold up the others',
    );
    assert.equal(recovered?.get(locked)?.state, 'unchanged');
    assert.equal(moved?.get(locked)?.state, 'changed');
  });

  test('a read that passes the timeout fails at the timeout, also when it never answers and ignores the signal, and the other gauges are not held up', async (t) => {
    // Arrange
    const clock = createClock();
    class Hung extends Gauge<number> {
      protected read() {
        return new Promise<number>(() => {});
      }
    }
    const hung = new Hung();
    const other = new Setting(1);
    const checks = new ChangeWatcher([hung, other], {
      interval: 5,
      timeout: 50,
      clock,
    }).watch(new AbortController().signal);

    // Act
    const first = checks.next();
    await t.waitFor(() => assert.equal(other.reads, 1));
    await clock.tickAsync(50);
    const outcomes = (await first).value ?? undefined;

    // Assert
    const outcome = outcomes?.get(hung);
    assert.equal(outcome?.state, 'failed');
    assert.equal(
      outcome?.state === 'failed' &&
        outcome.error instanceof DOMException &&
        outcome.error.name,
      'TimeoutError',
    );
    assert.equal(outcomes?.get(other)?.state, 'changed');
    assert.equal(
      clock.countTimers(),
      0,
      'The timer of the timeout must end with the check',
    );
  });

  test('a group changes when one of its members changes, and fails when one of its members fails', async (t) => {
    // Arrange
    const clock = createClock();
    const statistics = new Setting('2 0');
    const rows = new Setting(1);
    const group = new Group([statistics, rows]);
    const checks = new ChangeWatcher([group], {
      interval: 5,
      timeout: 5,
      clock,
    }).watch(new AbortController().signal);
    const next = async () => {
      const result = checks.next();
      await t.waitFor(() => assert.equal(clock.countTimers(), 1));
      await clock.tickAsync(5);
      return (await result).value?.get(group) ?? undefined;
    };

    // Act
    await checks.next();
    const unchanged = await next();
    rows.current = 2;
    const changed = await next();
    statistics.failure = new Error('refused');
    const failed = await next();

    // Assert
    assert.equal(unchanged?.state, 'unchanged');
    assert.equal(changed?.state, 'changed');
    assert.equal(failed?.state, 'failed');
  });

  test('a period counts the whole periods since the watch started, not the periods of the clock', async (t) => {
    // Arrange: the watch starts at 07:12, in the middle of an hour.
    const clock = createClock(Date.UTC(2026, 10, 6, 7, 12));
    const hour = new Period(60 * 60_000);
    const checks = new ChangeWatcher([hour], {
      interval: 30_000,
      timeout: 1_000,
      clock,
    }).watch(new AbortController().signal);
    const after = async (ms: number) => {
      const result = checks.next();
      await t.waitFor(() => assert.equal(clock.countTimers(), 1));
      clock.setSystemTime(clock.now + ms - 30_000);
      await clock.tickAsync(30_000);
      return (await result).value?.get(hour)?.state;
    };

    // Act
    await checks.next();
    const pastEight = await after(50 * 60_000);
    const anHour = await after(10 * 60_000);

    // Assert
    assert.equal(
      pastEight,
      'unchanged',
      'Passing 08:00 on the clock is not an hour of the watch',
    );
    assert.equal(anHour, 'changed');
  });

  test('NaN does not change at every check, also inside a group', async (t) => {
    // Arrange
    const clock = createClock();
    const nan = new Setting(Number.NaN);
    const group = new Group([new Setting(Number.NaN)]);
    const checks = new ChangeWatcher([nan, group], {
      interval: 5,
      timeout: 5,
      clock,
    }).watch(new AbortController().signal);
    await checks.next();

    // Act
    const next = checks.next();
    await t.waitFor(() => assert.equal(clock.countTimers(), 1));
    await clock.tickAsync(5);

    // Assert
    const outcomes = (await next).value ?? undefined;
    assert.equal(outcomes?.get(nan)?.state, 'unchanged');
    assert.equal(outcomes?.get(group)?.state, 'unchanged');
  });

  test('a gauge reads one time in a check, also when it is watched itself, is a member of two groups, and is given two times', async (t) => {
    // Arrange
    const clock = createClock();
    const version = new Setting(1);
    const first = new Group([version]);
    const second = new Group([version, new Setting('x')]);
    const checks = new ChangeWatcher([version, first, second, version], {
      interval: 5,
      timeout: 5,
      clock,
    }).watch(new AbortController().signal);

    // Act
    const firstCheck = (await checks.next()).value ?? undefined;
    const next = checks.next();
    await t.waitFor(() => assert.equal(clock.countTimers(), 1));
    await clock.tickAsync(5);
    await next;

    // Assert
    assert.equal(
      version.reads,
      2,
      'Each of the two checks must read the shared gauge one time',
    );
    assert.deepEqual(
      [...(firstCheck?.keys() ?? [])],
      [version, first, second],
      'A gauge given two times has one outcome',
    );
  });

  test('a read that throws at once fails the gauge and every group it is in, with the same error and one read in the check', async () => {
    // Arrange
    const failure = new Error('database is locked');
    class Locked extends Gauge<number> {
      reads = 0;
      protected read(): Promise<number> {
        this.reads++;
        throw failure;
      }
    }
    const locked = new Locked();
    const group = new Group([locked]);
    const checks = new ChangeWatcher([locked, group], {
      interval: 5,
      timeout: 5,
      clock: globalThis,
    }).watch(new AbortController().signal);

    try {
      // Act
      const outcomes = (await checks.next()).value ?? undefined;

      // Assert
      assert.equal(locked.reads, 1, 'Both callers must share one read');
      assert.deepEqual(outcomes?.get(locked), {
        state: 'failed',
        error: failure,
      });
      assert.deepEqual(
        outcomes?.get(group),
        { state: 'failed', error: failure },
        'The group must fail with the error of its member, not hang or time out',
      );
    } finally {
      await checks.return();
    }
  });

  test('a caller that asks for a gauge after its read failed in the same check gets the same error, with no second read', async () => {
    // Arrange
    const failure = new Error('database is locked');
    class Locked extends Gauge<number> {
      reads = 0;
      protected read(): Promise<number> {
        this.reads++;
        throw failure;
      }
    }
    const locked = new Locked();
    // Asks for the gauge again only after the first read has failed.
    class Retry extends Gauge<number> {
      protected async read(check: Check) {
        await locked.value(check).catch(() => {});
        return locked.value(check);
      }
    }
    const retry = new Retry();
    const checks = new ChangeWatcher([locked, retry], {
      interval: 5,
      timeout: 5,
      clock: globalThis,
    }).watch(new AbortController().signal);

    try {
      // Act
      const outcomes = (await checks.next()).value ?? undefined;

      // Assert
      assert.equal(
        locked.reads,
        1,
        'A failed read must not run again in its check',
      );
      assert.deepEqual(outcomes?.get(retry), {
        state: 'failed',
        error: failure,
      });
    } finally {
      await checks.return();
    }
  });

  test('an abort during the wait ends the iteration with no error, stops the timer, and no read follows', async (t) => {
    // Arrange
    const clock = createClock();
    const controller = new AbortController();
    const store = new Setting(1);
    const checks = new ChangeWatcher([store], {
      interval: 60_000,
      timeout: 5,
      clock,
    }).watch(controller.signal);
    await checks.next();
    const next = checks.next();
    await t.waitFor(() => assert.equal(clock.countTimers(), 1));

    // Act
    controller.abort(new Error('the watch stopped'));

    // Assert
    assert.deepEqual(await next, { done: true, value: undefined });
    assert.equal(clock.countTimers(), 0, 'The abort must stop the timer');
    await clock.tickAsync(60_000);
    assert.equal(store.reads, 1);
  });

  test('an abort while the consumer holds a check ends the next check at once, with no timer and no read', async () => {
    // Arrange
    const clock = createClock();
    const controller = new AbortController();
    const store = new Setting(1);
    const checks = new ChangeWatcher([store], {
      interval: 60_000,
      timeout: 5,
      clock,
    }).watch(controller.signal);
    await checks.next();

    // Act
    controller.abort();
    const next = await checks.next();

    // Assert
    assert.deepEqual(next, { done: true, value: undefined });
    assert.equal(clock.countTimers(), 0);
    assert.equal(store.reads, 1);
  });

  test('an abort during the reads ends the iteration with no result of that check', async () => {
    // Arrange
    const clock = createClock();
    const controller = new AbortController();
    class Slow extends Gauge<number> {
      readonly started = new Latch();
      protected read(check: Check) {
        this.started.open();
        return new Promise<number>((resolve) =>
          check.signal.addEventListener('abort', () => resolve(1)),
        );
      }
    }
    const slow = new Slow();
    const checks = new ChangeWatcher([slow], {
      interval: 5,
      timeout: 60_000,
      clock,
    }).watch(controller.signal);
    const first = checks.next();
    await slow.started.wait();

    // Act
    controller.abort();

    // Assert
    assert.deepEqual(await first, { done: true, value: undefined });
  });

  test('a signal that aborted before the call ends the iteration before the first read', async () => {
    // Arrange
    const clock = createClock();
    const store = new Setting(1);

    // Act
    const checks = await Array.fromAsync(
      new ChangeWatcher([store], { interval: 5, timeout: 5, clock }).watch(
        AbortSignal.abort(),
      ),
    );

    // Assert
    assert.deepEqual(checks, []);
    assert.equal(store.reads, 0, 'A stopped watch must not read the store');
    assert.equal(clock.countTimers(), 0);
  });

  test('a process that aborts a watch during its wait ends at once, because the timer of the wait stops', async () => {
    // Arrange
    const program = `
        import { ChangeWatcher, Gauge } from ${JSON.stringify(import.meta.resolve('./index.ts'))};
        class Store extends Gauge { async read() { return 1; } }
        const controller = new AbortController();
        const checks = new ChangeWatcher([new Store()], { interval: 60_000, timeout: 5, clock: globalThis }).watch(controller.signal);
        await checks.next();
        setImmediate(() => controller.abort());
        await checks.next();
      `;

    // Act
    const run = execFileAsync(
      process.execPath,
      ['--input-type=module', '--eval', program],
      {
        timeout: 5_000,
      },
    );

    // Assert
    await assert.doesNotReject(
      run,
      'The process must end when the watch is aborted, not after the interval of 60 seconds',
    );
  });

  test('after a slow consumer, the next check still waits the full interval from when the consumer asks', async () => {
    // Arrange
    const clock = createClock();
    const interval = 200;
    const times: number[] = [];
    class Stamp extends Gauge<number> {
      protected async read() {
        times.push(clock.now);
        return times.length;
      }
    }
    const checks = new ChangeWatcher([new Stamp()], {
      interval,
      timeout: 5,
      clock,
    }).watch(new AbortController().signal);
    await checks.next();

    // Act
    for (let slow = 0; slow < 2; slow++) {
      await clock.tickAsync(interval * 2);
      const next = checks.next();
      await clock.tickAsync(interval - 1);
      const early = times.length;
      await clock.tickAsync(1);
      await next;
      assert.equal(
        times.length,
        early + 1,
        'The check must come one full interval after the consumer asks',
      );
    }

    // Assert
    assert.deepEqual(times, [0, interval * 3, interval * 6]);
  });

  test('an interval longer than one timer can hold (2^31 ms; a Node timer fires such a delay at once) waits that long before the next check', async (t) => {
    // Arrange: createClock() fires a timer above 2^31-1 ms after 1 ms, as Node.js does.
    const clock = createClock();
    const thirtyDays = 30 * 24 * 60 * 60_000;
    const books = new Setting(1);
    const checks = new ChangeWatcher([books], {
      interval: thirtyDays,
      timeout: 5,
      clock,
    }).watch(new AbortController().signal);
    await checks.next();

    // Act
    const second = checks.next();
    await t.waitFor(() => assert.equal(clock.countTimers(), 1));
    await clock.tickAsync(thirtyDays - 1);
    const readsEarly = books.reads;
    await clock.tickAsync(1);
    await second;

    // Assert
    assert.equal(
      readsEarly,
      1,
      'The second check must not read before 30 days',
    );
    assert.equal(books.reads, 2);
    assert.equal(clock.now, thirtyDays);
  });

  test('an interval, a timeout or a period that is not a positive number of milliseconds is refused', () => {
    // Arrange
    const clock = createClock();

    // Act and Assert
    for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => new ChangeWatcher([], { interval: ms, timeout: 5, clock }),
        RangeError,
      );
      assert.throws(
        () => new ChangeWatcher([], { interval: 5, timeout: ms, clock }),
        RangeError,
      );
      assert.throws(() => new Period(ms), RangeError);
    }
  });
});
