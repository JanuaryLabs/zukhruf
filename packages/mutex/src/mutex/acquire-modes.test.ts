import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';

import { describe } from '@zukhruf/testing/node';

import { MemoryStore } from '../lock-stores/memory/memory-store.ts';
import { hold } from '../testing/hold.ts';
import { settle } from '../testing/timing.ts';
import type { AcquireMode } from './acquire-mode.ts';
import { Modes } from './acquire-modes/modes.ts';
import { Mutex } from './mutex.ts';

/** Resolves `'done'` if `work` settles within `milliseconds`, otherwise `'still waiting'`. */
function within(work: Promise<unknown>, milliseconds: number) {
  return Promise.race([
    work.then(() => 'done' as const),
    delay(milliseconds, 'still waiting' as const, { ref: false }),
  ]);
}

describe('The time limit of skip if busy', () => {
  test('the limit starts when the lock store answers, so a free key that it answers late is still acquired', async (t) => {
    // Arrange: a lock store whose first answer comes 100 ms after the call, on
    // the clock of the limit, as while a coordinator connects.
    const clock = createClock();
    const inner = new MemoryStore();
    const mutex = new Mutex({
      acquire: (key, options) => inner.acquire(key, options),
      tryAcquire: async (key) => {
        await new Promise((resolve) => clock.setTimeout(resolve, 100));
        return inner.tryAcquire(key);
      },
      isHeld: (key) => inner.isHeld(key),
    });
    const acquiring = mutex.acquire('report:daily', async () => 'report', {
      mode: Modes.skipIfBusy({ waitAtMost: 20, clock }),
    });
    await t.waitFor(() => assert.equal(clock.countTimers(), 1));

    // Act
    await clock.tickAsync(100);

    // Assert: a slow answer is not a busy key, so the mode does not give up.
    assert.deepEqual(await acquiring, { acquired: true, value: 'report' });
  });
});

describe('Cancelling a wait', () => {
  test("a key passes one call's signal on, with its own mode and with an override", async () => {
    // Arrange
    const mutex = new Mutex(new MemoryStore());
    const report = mutex.key('report:daily', {
      mode: Modes.skipIfBusy({ waitAtMost: 10_000, clock: globalThis }),
    });
    const holder = await hold(mutex, report.name);
    const cancel = new AbortController();
    const reason = new Error('cancelled');
    const own = report.run(async () => 'own', { signal: cancel.signal });
    const overridden = report.run(async () => 'overridden', {
      mode: Modes.wait(),
      signal: cancel.signal,
    });

    try {
      // Act
      cancel.abort(reason);
      const results = await Promise.allSettled([own, overridden]);

      // Assert
      assert.deepEqual(
        results.map(
          (result) => result.status === 'rejected' && result.reason === reason,
        ),
        [true, true],
      );
    } finally {
      await holder.release();
    }
  });

  test("each built-in mode passes the caller's signal on to the lock store, so the store stops waiting", async () => {
    // Arrange: a lock store that records the signal of each wait, and a holder outside it.
    const inner = new MemoryStore();
    const signals: (AbortSignal | undefined)[] = [];
    const mutex = new Mutex({
      acquire: (key, options) => {
        signals.push(options?.signal);
        return inner.acquire(key, options);
      },
      tryAcquire: (key) => inner.tryAcquire(key),
      isHeld: (key) => inner.isHeld(key),
    });
    await using _holder = await inner.acquire('report:daily');
    const cancel = new AbortController();
    const calls = Promise.allSettled([
      mutex.acquire('report:daily', async () => {}, {
        mode: Modes.wait(),
        signal: cancel.signal,
      }),
      mutex.acquire('report:daily', async () => {}, {
        mode: Modes.skipIfBusy({ waitAtMost: 10_000, clock: globalThis }),
        signal: cancel.signal,
      }),
    ]);
    assert.equal(await within(calls, settle), 'still waiting');

    // Act
    cancel.abort(new Error('cancelled'));
    await calls;

    // Assert
    assert.deepEqual(
      signals.map((signal) => signal?.aborted),
      [true, true],
    );
  });

  test('a mode that does not pass the signal on still rejects at once, and gives back the key it gets later', async () => {
    // Arrange: a custom mode that waits without the caller's signal.
    const mutex = new Mutex(new MemoryStore());
    const unheeding: AcquireMode<'always'> = {
      outcome: 'always',
      acquire: (store, key) => store.acquire(key),
    };
    const holder = await hold(mutex, 'report:daily');
    const cancel = new AbortController();
    const reason = new Error('cancelled');
    let ran = false;
    const cancelled = mutex.acquire(
      'report:daily',
      async () => {
        ran = true;
      },
      { mode: unheeding, signal: cancel.signal },
    );

    try {
      // Act
      cancel.abort(reason);

      // Assert: the caller does not wait for the holder to release.
      await assert.rejects(cancelled, (error) => error === reason);
    } finally {
      await holder.release();
    }
    assert.equal(
      await mutex.acquire('report:daily', async () => 'next'),
      'next',
      'The key that the mode got after the cancel must be given back',
    );
    assert.equal(ran, false, 'A caller that cancelled must not run its task');
  });

  test("skipIfBusy rejects when its caller cancels during the first attempt, and gives that attempt's key back", async () => {
    // Arrange: a lock store whose one attempt answers only when the gate opens.
    const inner = new MemoryStore();
    const gate = Promise.withResolvers<void>();
    const mutex = new Mutex({
      acquire: (key, options) => inner.acquire(key, options),
      tryAcquire: async (key) => {
        await gate.promise;
        return inner.tryAcquire(key);
      },
      isHeld: (key) => inner.isHeld(key),
    });
    const cancel = new AbortController();
    const reason = new Error('cancelled');
    let ran = false;
    const attempt = mutex.acquire(
      'report:daily',
      async () => {
        ran = true;
      },
      { mode: Modes.skipIfBusy(), signal: cancel.signal },
    );

    // Act: the caller cancels, and then its attempt gets the free key.
    cancel.abort(reason);
    gate.resolve();

    // Assert
    await assert.rejects(attempt, (error) => error === reason);
    assert.equal(
      await mutex.acquire('report:daily', async () => 'next'),
      'next',
      'The key that the attempt got after the cancel must be given back',
    );
    assert.equal(ran, false, 'A caller that cancelled must not run its task');
  });

  test('a caller that cancels after its task started gets the task value, and holds the key until the task ends', async () => {
    // Arrange
    const mutex = new Mutex(new MemoryStore());
    const cancel = new AbortController();
    let duringTask: unknown;

    // Act
    const value = await mutex.acquire(
      'report:daily',
      async () => {
        cancel.abort(new Error('cancelled'));
        duringTask = await mutex.acquire('report:daily', async () => 'other', {
          mode: Modes.skipIfBusy(),
        });
        return 'report';
      },
      { signal: cancel.signal },
    );

    // Assert
    assert.equal(value, 'report');
    assert.deepEqual(duringTask, { acquired: false });
  });
});

describe('Acquire mode result types', () => {
  test('a mode that says it always acquires but gives up rejects instead of running the task', async () => {
    // Arrange: a custom mode that breaks its contract.
    const mutex = new Mutex(new MemoryStore());
    const brokenWait: AcquireMode<'always'> = {
      outcome: 'always',
      acquire: async () => undefined,
    };
    let ran = false;

    // Act
    const call = mutex.acquire(
      'report:daily',
      async () => {
        ran = true;
      },
      { mode: brokenWait },
    );

    // Assert: the caller learns of the broken mode, and gets no value typed as the task's.
    await assert.rejects(
      call,
      /outcome is 'always' gave up on key "report:daily"/,
    );
    assert.equal(ran, false, 'The task must not run without the key');
  });

  test('the result type follows the acquire mode', async () => {
    const mutex = new Mutex(new MemoryStore());

    const value: number = await mutex.acquire('k', async () => 1);
    const result = await mutex.acquire('k', async () => 1, {
      mode: Modes.skipIfBusy(),
    });
    // @ts-expect-error a mode that may give up must be checked before its value is read
    void result.value;
    const checked: number = result.acquired ? result.value : 0;

    const key = mutex.key('k', { mode: Modes.skipIfBusy() });
    const viaKey = await key.run(async () => 'x');
    // @ts-expect-error the key's default mode may give up
    void viaKey.value;
    const overridden: string = await key.run(async () => 'x', {
      mode: Modes.wait(),
    });

    const { signal } = new AbortController();
    const cancellable: number = await mutex.acquire('k', async () => 1, {
      signal,
    });
    const cancellableSkip = await key.run(async () => 'x', { signal });
    // @ts-expect-error a signal does not change what a mode that may give up returns
    void cancellableSkip.value;
    // @ts-expect-error a signal belongs to one call, not to a key
    mutex.key('k', { mode: Modes.skipIfBusy(), signal });

    assert.deepEqual(
      [value, checked, viaKey, overridden, cancellable, cancellableSkip],
      [
        1,
        1,
        { acquired: true, value: 'x' },
        'x',
        1,
        { acquired: true, value: 'x' },
      ],
    );
  });

  test('a negative or infinite time limit is refused', () => {
    assert.throws(
      () => Modes.skipIfBusy({ waitAtMost: -1, clock: globalThis }),
      RangeError,
    );
    assert.throws(
      () =>
        Modes.skipIfBusy({
          waitAtMost: Number.POSITIVE_INFINITY,
          clock: globalThis,
        }),
      RangeError,
    );
  });
});
