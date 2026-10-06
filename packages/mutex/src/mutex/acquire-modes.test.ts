import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Worker } from 'node:worker_threads';

import { MemoryStore } from '../lock-stores/memory/memory-store.ts';
import { scratchDirectory } from '../testing/scratch-directory.ts';
import { type StoreHost, settle, storeCases } from '../testing/store-cases.ts';
import { waitUntil } from '../testing/wait-until.ts';
import { startWorker } from '../testing/worker-process.ts';
import type { AcquireMode } from './acquire-mode.ts';
import { Modes } from './acquire-modes/modes.ts';
import { Mutex } from './mutex.ts';

const mutexUrl = new URL('./mutex.ts', import.meta.url);
const modesUrl = new URL('./acquire-modes/modes.ts', import.meta.url);
const storeCasesUrl = new URL('../testing/store-cases.ts', import.meta.url);

/** Holds `key` until the returned `release` is called. */
async function hold(mutex: Mutex, key: string) {
  const entered = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const held = mutex.acquire(key, async () => {
    entered.resolve();
    await finish.promise;
  });
  await entered.promise;
  return {
    release: async () => {
      finish.resolve();
      await held;
    },
  };
}

/** Resolves `'done'` if `work` settles within `milliseconds`, otherwise `'still waiting'`. */
async function within(work: Promise<unknown>, milliseconds: number) {
  const timeout = Promise.withResolvers<'still waiting'>();
  const timer = setTimeout(
    () => timeout.resolve('still waiting'),
    milliseconds,
  );
  try {
    return await Promise.race([
      work.then(() => 'done' as const),
      timeout.promise,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

for (const store of storeCases) {
  describe(`Acquire modes with ${store.name}`, () => {
    test(
      'skipIfBusy gives up at once while another holder has the key, and does not run the task',
      { timeout: 5000 },
      async () => {
        // Arrange
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        const mutex = new Mutex(host.store);
        const holder = await hold(mutex, 'report:daily');
        let ran = false;

        try {
          // Act
          const result = await mutex.acquire(
            'report:daily',
            async () => {
              ran = true;
              return 'report';
            },
            { mode: Modes.skipIfBusy() },
          );

          // Assert
          assert.deepEqual(result, { acquired: false });
          assert.equal(ran, false, 'A skipped caller must not run its task');
        } finally {
          await holder.release();
        }
      },
    );

    test('skipIfBusy acquires a free key and gives back the task value', async () => {
      // Arrange
      await using directory = await scratchDirectory();
      await using host = store.open(directory.path);
      const mutex = new Mutex(host.store);

      // Act
      const result = await mutex.acquire('report:daily', async () => 'report', {
        mode: Modes.skipIfBusy(),
      });

      // Assert
      assert.deepEqual(result, { acquired: true, value: 'report' });
    });

    test(
      'skipIfBusy({ waitAtMost }) gives up after the limit while the key stays busy',
      { timeout: 5000 },
      async () => {
        // Arrange
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        const mutex = new Mutex(host.store);
        const holder = await hold(mutex, 'report:daily');

        try {
          // Act
          const started = performance.now();
          const result = await mutex.acquire(
            'report:daily',
            async () => 'report',
            {
              mode: Modes.skipIfBusy({ waitAtMost: 100 }),
            },
          );
          const waited = performance.now() - started;

          // Assert
          assert.deepEqual(result, { acquired: false });
          assert.ok(
            waited >= 90,
            `The caller gave up after ${waited.toFixed(0)} ms, before its 100 ms limit`,
          );
        } finally {
          await holder.release();
        }
      },
    );

    test(
      'skipIfBusy({ waitAtMost }) acquires when the key is released within the limit',
      { timeout: 5000 },
      async () => {
        // Arrange
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        const mutex = new Mutex(host.store);
        const holder = await hold(mutex, 'report:daily');

        // Act
        const attempt = mutex.acquire('report:daily', async () => 'report', {
          mode: Modes.skipIfBusy({ waitAtMost: 2000 }),
        });
        await delay(50);
        await holder.release();

        // Assert
        assert.deepEqual(await attempt, { acquired: true, value: 'report' });
      },
    );

    test(
      'a caller that gave up does not block the callers after it',
      { timeout: 5000 },
      async () => {
        // Arrange: a holder, a caller that gives up, and a caller that waits behind it.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        const mutex = new Mutex(host.store);
        const holder = await hold(mutex, 'report:daily');
        const gaveUp = await mutex.acquire(
          'report:daily',
          async () => 'report',
          {
            mode: Modes.skipIfBusy({ waitAtMost: 50 }),
          },
        );
        const waiter = mutex.acquire('report:daily', async () => 'report');

        // Act
        await holder.release();

        // Assert
        assert.deepEqual(gaveUp, { acquired: false });
        assert.equal(
          await within(waiter, 2000),
          'done',
          'The waiting caller must get the key; the caller that gave up must not keep it',
        );
      },
    );

    test(
      "a key's default mode applies, and one call can override it",
      { timeout: 5000 },
      async () => {
        // Arrange: callers of this key skip by default.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
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
      },
    );

    test(
      'a waiting caller that cancels rejects with its reason, and the callers after it still get the key',
      { timeout: 5000 },
      async () => {
        // Arrange: a holder, a caller that will cancel, and a caller that waits.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
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
          assert.equal(await within(cancelled, settle), 'still waiting');

          // Act
          cancel.abort(reason);

          // Assert
          await assert.rejects(cancelled, (error) => error === reason);
        } finally {
          await holder.release();
        }
        assert.equal(
          await within(next, 2000),
          'done',
          'The caller that cancelled must not keep the key from the caller after it',
        );
        assert.equal(
          ran,
          false,
          'A caller that cancelled must not run its task',
        );
      },
    );

    test(
      'skipIfBusy({ waitAtMost }) rejects with the reason when its caller cancels before the limit',
      { timeout: 5000 },
      async () => {
        // Arrange
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        const mutex = new Mutex(host.store);
        const holder = await hold(mutex, 'report:daily');
        const cancel = new AbortController();
        const reason = new Error('cancelled');
        const attempt = mutex.acquire('report:daily', async () => 'report', {
          mode: Modes.skipIfBusy({ waitAtMost: 10_000 }),
          signal: cancel.signal,
        });

        try {
          assert.equal(await within(attempt, settle), 'still waiting');

          // Act
          cancel.abort(reason);

          // Assert: a cancel is a rejection, not a mode that gave up.
          await assert.rejects(attempt, (error) => error === reason);
        } finally {
          await holder.release();
        }
      },
    );

    test(
      'skipIfBusy({ waitAtMost }) still gives up after the limit when its caller has a signal that does not abort',
      { timeout: 5000 },
      async () => {
        // Arrange
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        const mutex = new Mutex(host.store);
        const holder = await hold(mutex, 'report:daily');

        try {
          // Act
          const result = await mutex.acquire(
            'report:daily',
            async () => 'report',
            {
              mode: Modes.skipIfBusy({ waitAtMost: 100 }),
              signal: new AbortController().signal,
            },
          );

          // Assert
          assert.deepEqual(result, { acquired: false });
        } finally {
          await holder.release();
        }
      },
    );

    test('a caller that already cancelled rejects in every mode, and leaves a free key free', async () => {
      // Arrange
      await using directory = await scratchDirectory();
      await using host = store.open(directory.path);
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
          mode: Modes.skipIfBusy({ waitAtMost: 100 }),
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

    test(
      'one signal shared by many calls keeps no abort listeners after they finish',
      { timeout: 5000 },
      async () => {
        // Arrange: a free key, a busy key, and a skip with a limit, all with one signal.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
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
          { mode: Modes.skipIfBusy({ waitAtMost: 50 }), signal },
        );
        await holder.release();
        await waited;

        // Assert
        assert.deepEqual(skipped, { acquired: false });
        assert.equal(getEventListeners(signal, 'abort').length, 0);
      },
    );
  });
}

describe('Cancelling a wait', () => {
  test("a key passes one call's signal on, with its own mode and with an override", async () => {
    // Arrange
    const mutex = new Mutex(new MemoryStore());
    const report = mutex.key('report:daily', {
      mode: Modes.skipIfBusy({ waitAtMost: 10_000 }),
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

  test(
    "each built-in mode passes the caller's signal on to the lock store, so the store stops waiting",
    { timeout: 5000 },
    async () => {
      // Arrange: a lock store that records the signal of each wait, and a holder outside it.
      const inner = new MemoryStore();
      const signals: (AbortSignal | undefined)[] = [];
      const mutex = new Mutex({
        acquire: (key, options) => {
          signals.push(options?.signal);
          return inner.acquire(key, options);
        },
        tryAcquire: (key) => inner.tryAcquire(key),
      });
      await using _holder = await inner.acquire('report:daily');
      const cancel = new AbortController();
      const calls = Promise.allSettled([
        mutex.acquire('report:daily', async () => {}, {
          mode: Modes.wait(),
          signal: cancel.signal,
        }),
        mutex.acquire('report:daily', async () => {}, {
          mode: Modes.skipIfBusy({ waitAtMost: 10_000 }),
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
    },
  );

  test(
    'a mode that does not pass the signal on still rejects at once, and gives back the key it gets later',
    { timeout: 5000 },
    async () => {
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
        await within(
          mutex.acquire('report:daily', async () => 'next'),
          2000,
        ),
        'done',
        'The key that the mode got after the cancel must be given back',
      );
      assert.equal(ran, false, 'A caller that cancelled must not run its task');
    },
  );

  test(
    "skipIfBusy rejects when its caller cancels during the first attempt, and gives that attempt's key back",
    { timeout: 5000 },
    async () => {
      // Arrange: a lock store whose one attempt answers only when the gate opens.
      const inner = new MemoryStore();
      const gate = Promise.withResolvers<void>();
      const mutex = new Mutex({
        acquire: (key, options) => inner.acquire(key, options),
        tryAcquire: async (key) => {
          await gate.promise;
          return inner.tryAcquire(key);
        },
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
        await within(
          mutex.acquire('report:daily', async () => 'next'),
          2000,
        ),
        'done',
        'The key that the attempt got after the cancel must be given back',
      );
      assert.equal(ran, false, 'A caller that cancelled must not run its task');
    },
  );

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
    assert.throws(() => Modes.skipIfBusy({ waitAtMost: -1 }), RangeError);
    assert.throws(
      () => Modes.skipIfBusy({ waitAtMost: Number.POSITIVE_INFINITY }),
      RangeError,
    );
  });
});

/** A child or thread that skips, then cancels a wait, while its host holds the key, and reports each result. */
const skipperBody = `
	const atOnce = await mutex.acquire('report:daily', async () => 'ran', { mode: Modes.skipIfBusy() });
	const afterLimit = await mutex.acquire('report:daily', async () => 'ran', { mode: Modes.skipIfBusy({ waitAtMost: 100 }) });
	const cancel = new AbortController();
	setTimeout(() => cancel.abort(new Error('cancelled')), 50);
	const cancelled = await mutex.acquire('report:daily', async () => 'ran', { signal: cancel.signal }).catch((error) => error.message);
	report({ type: 'results', atOnce, afterLimit, cancelled });
`;

for (const store of storeCases.filter(
  (candidate) =>
    candidate.reach === 'host' || candidate.reach === 'process-tree',
)) {
  describe(`Acquire modes across processes with ${store.name}`, () => {
    test(
      'a process that skips or cancels while another process holds gets no key, and leaves the key free',
      { timeout: 10000 },
      async (t) => {
        // Arrange: this process holds the key; a child (kept alive) tries to skip.
        await using directory = await scratchDirectory();
        await using host = store.open(directory.path);
        const mutex = new Mutex(host.store);
        const holder = await hold(mutex, 'report:daily');
        await using child = startWorker(
          `
					import { Mutex } from ${JSON.stringify(mutexUrl.href)};
					import { Modes } from ${JSON.stringify(modesUrl.href)};
					import { createChildStore } from ${JSON.stringify(storeCasesUrl.href)};
					setInterval(() => {}, 1000);
					const mutex = new Mutex(createChildStore(${JSON.stringify(store.name)}, ${JSON.stringify(directory.path)}));
					const report = (message) => process.send(message);
					${skipperBody}
				`,
          'skipper',
          { host },
        );

        // Act
        await waitUntil(
          t,
          () => child.has('results'),
          `The child must report.\n${child.stderr}`,
          5000,
        );
        await holder.release();

        // Assert: both skips gave up, the wait was cancelled, and no grant was left with the child.
        assert.deepEqual(
          {
            atOnce: child.find('results')?.atOnce,
            afterLimit: child.find('results')?.afterLimit,
            cancelled: child.find('results')?.cancelled,
          },
          {
            atOnce: { acquired: false },
            afterLimit: { acquired: false },
            cancelled: 'cancelled',
          },
        );
        assert.equal(
          await within(
            mutex.acquire('report:daily', async () => 'next'),
            2000,
          ),
          'done',
          'The key must be free after the holder releases it; the child that gave up must not keep it',
        );
      },
    );
  });
}

for (const store of storeCases.filter(
  (candidate) => candidate.reach === 'process',
)) {
  describe(`Acquire modes across threads with ${store.name}`, () => {
    test(
      'a thread that skips or cancels while another thread holds gets no key, and leaves the key free',
      { timeout: 10000 },
      async () => {
        // Arrange: the main thread holds the key; a worker (kept alive) tries to skip.
        await using directory = await scratchDirectory();
        await using host: StoreHost = store.open(directory.path);
        const mutex = new Mutex(host.store);
        const holder = await hold(mutex, 'report:daily');
        const thread = new Worker(
          `
					(async () => {
						const { parentPort } = await import('node:worker_threads');
						const { Mutex } = await import(${JSON.stringify(mutexUrl.href)});
						const { Modes } = await import(${JSON.stringify(modesUrl.href)});
						const { createThreadStore } = await import(${JSON.stringify(storeCasesUrl.href)});
						setInterval(() => {}, 1000);
						const mutex = new Mutex(createThreadStore(${JSON.stringify(store.name)}, ${JSON.stringify(directory.path)}));
						const report = (message) => parentPort.postMessage(message);
						${skipperBody}
					})();
				`,
          { eval: true },
        );
        host.adoptThread(thread);
        const results = new Promise<{
          atOnce: unknown;
          afterLimit: unknown;
          cancelled: unknown;
        }>((resolve) =>
          thread.on('message', (message) => {
            if (message?.type === 'results') resolve(message);
          }),
        );

        try {
          // Act
          const reported = await results;
          await holder.release();

          // Assert
          assert.deepEqual(
            {
              atOnce: reported.atOnce,
              afterLimit: reported.afterLimit,
              cancelled: reported.cancelled,
            },
            {
              atOnce: { acquired: false },
              afterLimit: { acquired: false },
              cancelled: 'cancelled',
            },
          );
          assert.equal(
            await within(
              mutex.acquire('report:daily', async () => 'next'),
              2000,
            ),
            'done',
            'The key must be free after the holder releases it; the thread that gave up must not keep it',
          );
        } finally {
          await thread.terminate();
        }
      },
    );
  });
}
