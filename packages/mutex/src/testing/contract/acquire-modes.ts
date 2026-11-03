import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';

import { describe, test } from '@zukhruf/testing/node';

import { Modes } from '../../mutex/acquire-modes/modes.ts';
import { Mutex } from '../../mutex/mutex.ts';
import { hold } from '../hold.ts';
import { newProcessTimeout } from '../new-process-timeout.ts';
import { settle } from '../timing.ts';
import { deadlineFor } from './deadlines.ts';
import type { Host, Subject } from './subject.ts';

/** Resolves `'done'` if `work` settles within `milliseconds`, otherwise `'still waiting'`. */
function within(work: Promise<unknown>, milliseconds: number) {
  return Promise.race([
    work.then(() => 'done' as const),
    delay(milliseconds, 'still waiting' as const, { ref: false }),
  ]);
}

/** Every lock store: each acquire mode. */
export function acquireModes<H extends Host>(store: Subject<H>): void {
  describe(`Acquire modes with ${store.name}`, () => {
    test('skipIfBusy gives up at once while another holder has the key, and does not run the task', async () => {
      // Arrange
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const holder = await hold(mutex, 'report:daily');
      let ran = false;

      try {
        // Act
        const started = performance.now();
        const result = await mutex.acquire(
          'report:daily',
          async () => {
            ran = true;
            return 'report';
          },
          { mode: Modes.skipIfBusy() },
        );
        const waited = performance.now() - started;

        // Assert
        assert.deepEqual(result, { acquired: false });
        assert.equal(ran, false, 'A skipped caller must not run its task');
        const limit = deadlineFor(store, 2000, { grants: 1, releases: 0 });
        assert.ok(
          waited < limit,
          `The caller gave up after ${waited.toFixed(0)} ms, not at once (within ${limit} ms)`,
        );
      } finally {
        await holder.release();
      }
    });

    test('skipIfBusy acquires a free key and gives back the task value', async () => {
      // Arrange
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);

      // Act
      const result = await mutex.acquire('report:daily', async () => 'report', {
        mode: Modes.skipIfBusy(),
      });

      // Assert
      assert.deepEqual(result, { acquired: true, value: 'report' });
    });

    test('skipIfBusy({ waitAtMost }) gives up after exactly the limit on its clock while the key stays busy', async (t) => {
      // Arrange: the limit runs on a fake clock; the lock store runs on real time.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const holder = await hold(mutex, 'report:daily');
      const clock = createClock();

      try {
        const skipping = mutex.acquire('report:daily', async () => 'report', {
          mode: Modes.skipIfBusy({ waitAtMost: 100, clock }),
        });
        // The lock store answered that the key is busy, so the limit runs.
        await t.waitFor(() => assert.equal(clock.countTimers(), 1), {
          timeout: newProcessTimeout,
        });

        // Act
        await clock.tickAsync(99);
        const limitsAt99 = clock.countTimers();
        await clock.tickAsync(1);

        // Assert
        assert.equal(limitsAt99, 1, 'The limit must not end before 100 ms');
        assert.deepEqual(await skipping, { acquired: false });
      } finally {
        await holder.release();
      }
    });

    test('skipIfBusy({ waitAtMost }) acquires when the key is released within the limit', async () => {
      // Arrange
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const holder = await hold(mutex, 'report:daily');

      // Act
      const attempt = mutex.acquire('report:daily', async () => 'report', {
        mode: Modes.skipIfBusy({ waitAtMost: 2000, clock: globalThis }),
      });
      await delay(50);
      await holder.release();

      // Assert
      assert.deepEqual(await attempt, { acquired: true, value: 'report' });
    });

    test('a caller that gave up does not block the callers after it', async () => {
      // Arrange: a holder, a caller that gives up, and a caller that waits behind it.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const holder = await hold(mutex, 'report:daily');
      const gaveUp = await mutex.acquire('report:daily', async () => 'report', {
        mode: Modes.skipIfBusy({ waitAtMost: 50, clock: globalThis }),
      });
      const waiter = mutex.acquire('report:daily', async () => 'report');

      // Act
      await holder.release();

      // Assert
      assert.deepEqual(gaveUp, { acquired: false });
      assert.equal(
        await waiter,
        'report',
        'The waiting caller must get the key; the caller that gave up must not keep it',
      );
    });

    test("a key's default mode applies, and one call can override it", async () => {
      // Arrange: callers of this key skip by default.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const report = mutex.key('report:daily', { mode: Modes.skipIfBusy() });
      const holder = await hold(mutex, report.name);

      // Act: one caller uses the default, another overrides it and waits.
      const skipped = await report.run(async () => 'cron run');
      const waited = report.run(async () => 'admin run', {
        mode: Modes.wait(),
      });
      await delay(50);
      await holder.release();

      // Assert
      assert.deepEqual(skipped, { acquired: false });
      assert.equal(
        await waited,
        'admin run',
        'An override to wait must run the task and give its value',
      );
    });

    test('a waiting caller that cancels rejects with its reason, and the callers after it still get the key', async () => {
      // Arrange: a holder, a caller that will cancel, and a caller that waits.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const holder = await hold(mutex, 'report:daily');
      const cancel = new AbortController();
      const reason = new Error('cancelled');
      let ran = false;
      const cancelled = mutex.acquire(
        'report:daily',
        async () => {
          ran = true;
        },
        { signal: cancel.signal },
      );
      const next = mutex.acquire('report:daily', async () => 'next');

      try {
        assert.equal(
          await within(
            cancelled,
            deadlineFor(store, settle, { grants: 1, releases: 0 }),
          ),
          'still waiting',
        );

        // Act
        cancel.abort(reason);

        // Assert
        await assert.rejects(cancelled, (error) => error === reason);
      } finally {
        await holder.release();
      }
      assert.equal(
        await next,
        'next',
        'The caller that cancelled must not keep the key from the caller after it',
      );
      assert.equal(ran, false, 'A caller that cancelled must not run its task');
    });

    test('skipIfBusy({ waitAtMost }) rejects with the reason when its caller cancels before the limit', async () => {
      // Arrange
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const holder = await hold(mutex, 'report:daily');
      const cancel = new AbortController();
      const reason = new Error('cancelled');
      const attempt = mutex.acquire('report:daily', async () => 'report', {
        mode: Modes.skipIfBusy({ waitAtMost: 10_000, clock: globalThis }),
        signal: cancel.signal,
      });

      try {
        assert.equal(
          await within(
            attempt,
            deadlineFor(store, settle, { grants: 1, releases: 0 }),
          ),
          'still waiting',
        );

        // Act
        cancel.abort(reason);

        // Assert: a cancel is a rejection, not a mode that gave up.
        await assert.rejects(attempt, (error) => error === reason);
      } finally {
        await holder.release();
      }
    });

    test('skipIfBusy({ waitAtMost }) still gives up after the limit when its caller has a signal that does not abort', async () => {
      // Arrange
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const holder = await hold(mutex, 'report:daily');

      try {
        // Act
        const result = await mutex.acquire(
          'report:daily',
          async () => 'report',
          {
            mode: Modes.skipIfBusy({ waitAtMost: 100, clock: globalThis }),
            signal: new AbortController().signal,
          },
        );

        // Assert
        assert.deepEqual(result, { acquired: false });
      } finally {
        await holder.release();
      }
    });

    test('a caller that already cancelled rejects in every mode, and leaves a free key free', async () => {
      // Arrange
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const reason = new Error('cancelled');
      const signal = AbortSignal.abort(reason);
      let ran = false;
      const task = async () => {
        ran = true;
      };

      // Act
      const results = await Promise.allSettled([
        mutex.acquire('report:daily', task, { signal }),
        mutex.acquire('report:daily', task, { mode: Modes.wait(), signal }),
        mutex.acquire('report:daily', task, {
          mode: Modes.skipIfBusy(),
          signal,
        }),
        mutex.acquire('report:daily', task, {
          mode: Modes.skipIfBusy({ waitAtMost: 100, clock: globalThis }),
          signal,
        }),
      ]);

      // Assert
      assert.deepEqual(
        results.map(
          (result) => result.status === 'rejected' && result.reason === reason,
        ),
        [true, true, true, true],
      );
      assert.equal(ran, false, 'A caller that cancelled must not run its task');
      assert.deepEqual(
        await mutex.acquire('report:daily', async () => 'next', {
          mode: Modes.skipIfBusy(),
        }),
        { acquired: true, value: 'next' },
      );
    });

    test('one signal shared by many calls keeps no abort listeners after they finish', async () => {
      // Arrange: a free key, a busy key, and a skip with a limit, all with one signal.
      await using fixture = await store.fixture(process.env);
      await using host = store.open(fixture.location);
      const mutex = new Mutex(host.store);
      const { signal } = new AbortController();
      await mutex.acquire('report:daily', async () => 'free', { signal });
      const holder = await hold(mutex, 'report:daily');
      const waited = mutex.acquire('report:daily', async () => 'waited', {
        signal,
      });

      // Act
      const skipped = await mutex.acquire(
        'report:daily',
        async () => 'skipped',
        {
          mode: Modes.skipIfBusy({ waitAtMost: 50, clock: globalThis }),
          signal,
        },
      );
      await holder.release();
      await waited;

      // Assert
      assert.deepEqual(skipped, { acquired: false });
      assert.equal(getEventListeners(signal, 'abort').length, 0);
    });
  });
}
