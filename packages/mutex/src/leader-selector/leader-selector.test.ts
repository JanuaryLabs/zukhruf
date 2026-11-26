import assert from 'node:assert/strict';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  setImmediate as afterPendingReactions,
  setTimeout as delay,
} from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';

import { Backoff } from '@zukhruf/async';
import { SqliteElection, type Term } from '@zukhruf/election';
import type { FencedLease } from '@zukhruf/fencing';
import { TemporaryFiles } from '@zukhruf/fs';
import { LeaseController, LeaseLostError } from '@zukhruf/lease';
import { describe, test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';

import {
  LeaderSelector,
  type LeaderSelectorListener,
  type LeaderSelectorOptions,
  LeaderSelectorWarning,
  type LockStore,
  Modes,
  Mutex,
} from '../index.ts';
import { MemoryStore } from '../lock-stores/memory/index.ts';
import { SocketStore } from '../lock-stores/socket/index.ts';
import { onUnixSockets } from '../testing/on-unix-sockets.ts';
import { settle } from '../testing/timing.ts';

/** Waits 1 s, 2 s, 4 s and so on, with no jitter, so each retry count has its own wait. */
const backoff = new Backoff({
  initial: 1000,
  multiplier: 2,
  max: 60_000,
  jitter: { kind: 'none' },
});

const both = [
  ['with autoRequeue', { autoRequeue: { backoff, clock: globalThis } }],
  ['without autoRequeue', {}],
] as const;

/** Holds the leadership until `signal` aborts, and then rejects with its reason, as a writer that runs until it is stopped. */
const untilStopped = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });

/** Resolves when `signal` aborts. */
const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );

/** Whether `promise` settled within the pending reactions. */
const settledSoon = async (promise: Promise<unknown>) => {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let turn = 0; turn < 5; turn++) await afterPendingReactions();
  return settled;
};

/**
 * A lock store over a MemoryStore. The test can take the last lease away, as
 * a database store loses a lease when its session ends, and can make the next
 * acquires fail, as a store whose server is down. It counts the acquires.
 */
function testStore() {
  const inner = new MemoryStore();
  const leases: LeaseController[] = [];
  const failures: Error[] = [];
  const releaseFailures: Error[] = [];
  let acquires = 0;
  const store: LockStore = {
    acquire: async (key, options) => {
      acquires++;
      const failure = failures.shift();
      if (failure) throw failure;
      const handle = await inner.acquire(key, options);
      const lease = new LeaseController(key);
      leases.push(lease);
      return {
        token: handle.token,
        signal: lease.signal,
        [Symbol.asyncDispose]: async () => {
          lease.end();
          await handle[Symbol.asyncDispose]();
          const failure = releaseFailures.shift();
          if (failure) throw failure;
        },
      };
    },
    tryAcquire: (key) => inner.tryAcquire(key),
    isHeld: (key) => inner.isHeld(key),
  };
  return {
    mutex: new Mutex(store),
    failNext: (failure: Error) => failures.push(failure),
    failNextRelease: (failure: Error) => releaseFailures.push(failure),
    loseLease: () => leases.at(-1)?.lose(),
    acquires: () => acquires,
  };
}

/** An election of the writer in `directory`. */
const writerElection = (directory: string) =>
  new SqliteElection({
    clock: globalThis,
    directory,
    claimFile: 'writer.lock',
    epochFile: 'writer.epoch',
  });

describe('The start', () => {
  test('the selector joins the line of the key before start returns', async () => {
    // Arrange
    const mutex = new Mutex(new MemoryStore());
    const order: string[] = [];

    // Act
    const selector = LeaderSelector.start(mutex.key('warehouse-writer'), {
      takeLeadership: async () => {
        order.push('selector');
      },
    });
    await mutex.acquire('warehouse-writer', async () => {
      order.push('other');
    });

    // Assert
    assert.deepEqual(order, ['selector', 'other']);
    await selector[Symbol.asyncDispose]();
  });
});

describe('A task that fails', () => {
  void test.each(both, ([name, options]) =>
    test(`${name}, it ends the selector after it gave the key up, and ended and the dispose reject with the failure`, async () => {
      // Arrange
      const mutex = new Mutex(new MemoryStore());
      const failure = new Error('The warehouse write failed');
      let rounds = 0;

      // Act
      const selector = LeaderSelector.start(
        mutex.key('warehouse-writer'),
        {
          takeLeadership: async () => {
            rounds++;
            throw failure;
          },
        },
        options,
      );

      // Assert
      await assert.rejects(selector.ended, (error) => error === failure);
      assert.equal(await mutex.isHeld('warehouse-writer'), false);
      await assert.rejects(
        selector[Symbol.asyncDispose](),
        (error) => error === failure,
      );
      assert.equal(rounds, 1, 'A failed task must not run again');
    }),
  );

  test('a task that rejects with another error than the stop after the dispose is a failure', async (t) => {
    // Arrange
    const mutex = new Mutex(new MemoryStore());
    const failure = new Error('The last flush failed');
    const selector = LeaderSelector.start(mutex.key('warehouse-writer'), {
      takeLeadership: async (_lease, signal) => {
        await aborted(signal);
        throw failure;
      },
    });
    await waitFor(() => assert.equal(selector.hasLeadership, true), {
      signal: t.signal,
    });

    // Act
    const disposed = selector[Symbol.asyncDispose]();

    // Assert
    await assert.rejects(disposed, (error) => error === failure);
    await assert.rejects(selector.ended, (error) => error === failure);
    assert.equal(await mutex.isHeld('warehouse-writer'), false);
  });
});

describe('A release that fails', () => {
  test('a release that fails after the task resolved ends the selector with that failure, and the selector leads no more', async () => {
    // Arrange: the store frees the key, then reports that its release failed.
    const failure = new Error(
      'The store lost its connection while it released the key',
    );
    const { mutex, failNextRelease, acquires } = testStore();
    failNextRelease(failure);
    let rounds = 0;

    // Act
    const selector = LeaderSelector.start(mutex.key('warehouse-writer'), {
      takeLeadership: async () => {
        rounds++;
      },
    });

    // Assert
    await assert.rejects(selector.ended, (error) => error === failure);
    assert.equal(rounds, 1);
    assert.equal(acquires(), 1);
    assert.throws(() => selector.requeue(), {
      message: 'This leader selector ended, so it leads no more.',
    });
  });
});

describe('An acquire that fails', () => {
  test('without autoRequeue, it ends the selector with the failure, and the task never runs', async () => {
    // Arrange
    const store = testStore();
    const failure = new Error('The lock server is down');
    store.failNext(failure);
    let ran = false;

    // Act
    const selector = LeaderSelector.start(store.mutex.key('warehouse-writer'), {
      takeLeadership: async () => {
        ran = true;
      },
    });

    // Assert
    await assert.rejects(selector.ended, (error) => error === failure);
    await assert.rejects(
      selector[Symbol.asyncDispose](),
      (error) => error === failure,
    );
    assert.equal(ran, false);
  });

  test('with autoRequeue, it warns and waits the back-off of the failed acquires since the last grant', async (t) => {
    // Arrange: two acquires fail, one is granted, and the next fails again.
    const emitWarning = t.mock.method(process, 'emitWarning', () => {});
    const clock = createClock();
    const store = testStore();
    const [first, second, third] = [1, 2, 3].map(
      (attempt) => new Error(`The lock server is down (${attempt})`),
    );
    store.failNext(first!);
    store.failNext(second!);
    let rounds = 0;
    await using selector = LeaderSelector.start(
      store.mutex.key('warehouse-writer'),
      {
        takeLeadership: async (_lease, signal) => {
          rounds++;
          if (rounds === 1) store.failNext(third!);
          else await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock } },
    );
    const backsOff = async (acquires: number, warnings: number) =>
      waitFor(
        () => {
          assert.equal(store.acquires(), acquires);
          assert.equal(emitWarning.mock.callCount(), warnings);
          assert.equal(clock.countTimers(), 1);
        },
        { signal: t.signal },
      );

    // Act and assert: 1 s after the first failure.
    await backsOff(1, 1);
    await clock.tickAsync(999);
    assert.equal(store.acquires(), 1, 'No acquire before the back-off');
    await clock.tickAsync(1);

    // 2 s after the second failure in a row.
    await backsOff(2, 2);
    await clock.tickAsync(1999);
    assert.equal(store.acquires(), 2, 'No acquire before the back-off');
    await clock.tickAsync(1);

    // The grant restarts the count: 1 s after the next failure.
    await backsOff(4, 3);
    assert.equal(rounds, 1);
    await clock.tickAsync(999);
    assert.equal(store.acquires(), 4, 'No acquire before the back-off');
    await clock.tickAsync(1);
    await waitFor(() => assert.equal(rounds, 2), { signal: t.signal });

    assert.deepEqual(
      emitWarning.mock.calls.map(({ arguments: [warning] }) =>
        Error.isError(warning)
          ? { ...warning, message: warning.message, cause: warning.cause }
          : warning,
      ),
      [first, second, third].map((failure) => ({
        name: 'LeaderSelectorWarning',
        code: 'ZUKHRUF_MUTEX_LEADER_SELECTOR_ACQUIRE_FAILED',
        detail: 'key: warehouse-writer',
        message: `The acquire failed, and the selector tries again: ${failure!.message}`,
        cause: failure,
      })),
    );
  });

  test('a dispose during the back-off ends the selector at once', async (t) => {
    // Arrange
    t.mock.method(process, 'emitWarning', () => {});
    const clock = createClock();
    const store = testStore();
    store.failNext(new Error('The lock server is down'));
    const selector = LeaderSelector.start(
      store.mutex.key('warehouse-writer'),
      { takeLeadership: async () => {} },
      { autoRequeue: { backoff, clock } },
    );
    await waitFor(() => assert.equal(clock.countTimers(), 1), {
      signal: t.signal,
    });

    // Act
    await selector[Symbol.asyncDispose]();

    // Assert
    await selector.ended;
    assert.equal(clock.countTimers(), 0, 'The back-off timer must stop');
    assert.equal(store.acquires(), 1);
  });
});

describe('The dispose', () => {
  void test.each(both, ([name, options]) =>
    test(`${name}, a dispose during the task aborts its signal, and waits until the task ended and the key was given up`, async (t) => {
      // Arrange
      const mutex = new Mutex(new MemoryStore());
      const steps: string[] = [];
      const selector = LeaderSelector.start(
        mutex.key('warehouse-writer'),
        {
          takeLeadership: async (_lease, signal) => {
            await aborted(signal);
            await afterPendingReactions();
            steps.push('flushed');
          },
        },
        options,
      );
      await waitFor(() => assert.equal(selector.hasLeadership, true), {
        signal: t.signal,
      });

      // Act
      const first = selector[Symbol.asyncDispose]();
      const second = selector[Symbol.asyncDispose]();

      // Assert
      await second;
      assert.deepEqual(steps, ['flushed'], 'A second dispose waits too');
      await first;
      assert.equal(await mutex.isHeld('warehouse-writer'), false);
      assert.equal(selector.hasLeadership, false);
      await selector.ended;
    }),
  );
  void test.each(both, ([name, options]) =>
    test(`${name}, a dispose during the wait for a busy key stops the wait, and the selector never takes the key`, async () => {
      // Arrange
      const mutex = new Mutex(new MemoryStore());
      const holder = Promise.withResolvers<void>();
      const holding = mutex.acquire('warehouse-writer', () => holder.promise);
      let ran = false;
      const selector = LeaderSelector.start(
        mutex.key('warehouse-writer'),
        {
          takeLeadership: async () => {
            ran = true;
          },
        },
        options,
      );

      // Act
      await selector[Symbol.asyncDispose]();

      // Assert
      await selector.ended;
      holder.resolve();
      await holding;
      assert.equal(ran, false);
      assert.equal(await mutex.isHeld('warehouse-writer'), false);
    }),
  );

  test('a dispose while the selector waits for requeue ends it clean', async (t) => {
    // Arrange: without autoRequeue, the first task resolves.
    const mutex = new Mutex(new MemoryStore());
    let rounds = 0;
    const selector = LeaderSelector.start(mutex.key('warehouse-writer'), {
      takeLeadership: async () => {
        rounds++;
      },
    });
    await waitFor(() => assert.equal(rounds, 1), { signal: t.signal });

    // Act
    await selector[Symbol.asyncDispose]();

    // Assert
    await selector.ended;
    assert.equal(rounds, 1);
    assert.equal(await mutex.isHeld('warehouse-writer'), false);
  });

  test('requeue throws after the dispose', async () => {
    // Arrange
    const mutex = new Mutex(new MemoryStore());
    const selector = LeaderSelector.start(mutex.key('warehouse-writer'), {
      takeLeadership: async () => {},
    });

    // Act
    await selector[Symbol.asyncDispose]();

    // Assert
    assert.throws(() => selector.requeue(), {
      message: 'This leader selector is disposed.',
    });
  });

  test('requeue throws after a failure ended the selector, which leads no more', async () => {
    // Arrange: a task that fails ends the selector, with no dispose; it holds nothing then, and its dispose would reject with the failure.
    const failure = new Error('The warehouse refused the write');
    const mutex = new Mutex(new MemoryStore());
    const selector = LeaderSelector.start(mutex.key('warehouse-writer'), {
      takeLeadership: async () => {
        throw failure;
      },
    });
    await assert.rejects(selector.ended, (error) => error === failure);

    // Act
    const requeueing = () => selector.requeue();

    // Assert
    assert.throws(requeueing, {
      message: 'This leader selector ended, so it leads no more.',
    });
  });
});

describe('A lost lease', () => {
  test('with autoRequeue, the task signal aborts with the loss, and the next round starts at once with the next grant', async (t) => {
    // Arrange
    const clock = createClock();
    const store = testStore();
    const leases: FencedLease[] = [];
    const signals: AbortSignal[] = [];
    await using selector = LeaderSelector.start(
      store.mutex.key('warehouse-writer'),
      {
        takeLeadership: async (lease, signal) => {
          leases.push(lease);
          signals.push(signal);
          await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock } },
    );
    await waitFor(() => assert.equal(leases.length, 1), { signal: t.signal });

    // Act
    store.loseLease();

    // Assert
    await waitFor(() => assert.equal(leases.length, 2), {
      signal: t.signal,
    });
    assert.ok(signals[0]!.reason instanceof LeaseLostError);
    assert.equal(clock.countTimers(), 0, 'A loss waits no back-off');
    assert.ok(leases[1]!.token.isNewerThan(leases[0]!.token));
    assert.equal(signals[1]!.aborted, false);
  });

  test('without autoRequeue, the selector waits for requeue, and requeue runs one round', async (t) => {
    // Arrange
    const store = testStore();
    let rounds = 0;
    await using selector = LeaderSelector.start(
      store.mutex.key('warehouse-writer'),
      {
        takeLeadership: async (_lease, signal) => {
          rounds++;
          await untilStopped(signal);
        },
      },
    );
    await waitFor(() => assert.equal(rounds, 1), { signal: t.signal });

    // Act
    store.loseLease();
    await waitFor(
      async () =>
        assert.equal(await store.mutex.isHeld('warehouse-writer'), false),
      { signal: t.signal },
    );

    // Assert
    assert.equal(await settledSoon(selector.ended), false);
    assert.equal(rounds, 1);
    assert.equal(selector.hasLeadership, false);
    assert.equal(selector.requeue(), true);
    await waitFor(() => assert.equal(rounds, 2), { signal: t.signal });
  });

  void test.each(
    ['rejects with another error', 'resolves'] as const,
    (ending) =>
      test(`a task that ${ending} after a loss has a loss, not a failure, so the selector leads again`, async (t) => {
        // Arrange
        const store = testStore();
        let rounds = 0;
        await using selector = LeaderSelector.start(
          store.mutex.key('warehouse-writer'),
          {
            takeLeadership: async (_lease, signal) => {
              rounds++;
              if (rounds > 1) return untilStopped(signal);
              await aborted(signal);
              if (ending === 'rejects with another error')
                throw new Error('The write after the loss failed');
            },
          },
          { autoRequeue: { backoff, clock: createClock() } },
        );
        await waitFor(() => assert.equal(rounds, 1), { signal: t.signal });

        // Act
        store.loseLease();

        // Assert
        await waitFor(() => assert.equal(rounds, 2), { signal: t.signal });
      }),
  );
});

describe('An interrupt', () => {
  test('with autoRequeue, it aborts the task signal, and the next round starts at once', async (t) => {
    // Arrange
    const clock = createClock();
    const mutex = new Mutex(new MemoryStore());
    const signals: AbortSignal[] = [];
    await using selector = LeaderSelector.start(
      mutex.key('warehouse-writer'),
      {
        takeLeadership: async (_lease, signal) => {
          signals.push(signal);
          await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock } },
    );
    await waitFor(() => assert.equal(signals.length, 1), { signal: t.signal });

    // Act
    selector.interruptLeadership();

    // Assert
    await waitFor(() => assert.equal(signals.length, 2), {
      signal: t.signal,
    });
    assert.equal(signals[0]!.aborted, true);
    assert.equal(signals[1]!.aborted, false);
    assert.equal(clock.countTimers(), 0, 'An interrupt waits no back-off');
  });

  test('without autoRequeue, it ends the round clean, and the selector waits for requeue', async (t) => {
    // Arrange
    const mutex = new Mutex(new MemoryStore());
    let rounds = 0;
    await using selector = LeaderSelector.start(mutex.key('warehouse-writer'), {
      takeLeadership: async (_lease, signal) => {
        rounds++;
        await untilStopped(signal);
      },
    });
    await waitFor(() => assert.equal(selector.hasLeadership, true), {
      signal: t.signal,
    });

    // Act
    selector.interruptLeadership();
    await waitFor(
      async () => assert.equal(await mutex.isHeld('warehouse-writer'), false),
      { signal: t.signal },
    );

    // Assert
    assert.equal(selector.hasLeadership, false);
    assert.equal(await settledSoon(selector.ended), false);
    assert.equal(rounds, 1);
    assert.equal(selector.requeue(), true);
    await waitFor(() => assert.equal(rounds, 2), { signal: t.signal });
  });

  test('an interrupt while the selector waits for a busy key does nothing', async (t) => {
    // Arrange
    const mutex = new Mutex(new MemoryStore());
    const holder = Promise.withResolvers<void>();
    const holding = mutex.acquire('warehouse-writer', () => holder.promise);
    const signals: AbortSignal[] = [];
    await using selector = LeaderSelector.start(mutex.key('warehouse-writer'), {
      takeLeadership: async (_lease, signal) => {
        signals.push(signal);
        await untilStopped(signal);
      },
    });

    // Act
    selector.interruptLeadership();
    holder.resolve();
    await holding;

    // Assert
    await waitFor(() => assert.equal(signals.length, 1), {
      signal: t.signal,
    });
    assert.equal(signals[0]!.aborted, false);
  });
});

describe('A task that resolves', () => {
  test('with autoRequeue, the next round starts at once', async (t) => {
    // Arrange
    const clock = createClock();
    const mutex = new Mutex(new MemoryStore());
    let rounds = 0;

    // Act
    await using selector = LeaderSelector.start(
      mutex.key('warehouse-writer'),
      {
        takeLeadership: async (_lease, signal) => {
          rounds++;
          if (rounds === 3) await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock } },
    );

    // Assert
    await waitFor(() => assert.equal(rounds, 3), { signal: t.signal });
    assert.equal(clock.countTimers(), 0);
  });

  test('without autoRequeue, the selector waits for requeue, and two requeues in a row queue one round', async (t) => {
    // Arrange
    const mutex = new Mutex(new MemoryStore());
    let rounds = 0;
    await using selector = LeaderSelector.start(mutex.key('warehouse-writer'), {
      takeLeadership: async () => {
        rounds++;
      },
    });
    await waitFor(() => assert.equal(rounds, 1), { signal: t.signal });
    await waitFor(
      async () => assert.equal(await mutex.isHeld('warehouse-writer'), false),
      { signal: t.signal },
    );

    // Act
    const requeues = [selector.requeue(), selector.requeue()];

    // Assert
    assert.deepEqual(requeues, [true, false]);
    await waitFor(() => assert.equal(rounds, 2), { signal: t.signal });
    await waitFor(
      async () => assert.equal(await mutex.isHeld('warehouse-writer'), false),
      { signal: t.signal },
    );
    assert.equal(await settledSoon(selector.ended), false);
    assert.equal(rounds, 2, 'Two requeues in a row must run one round');
  });
});

describe('The state of the selector', () => {
  test('hasLeadership is true only while the task runs', async (t) => {
    // Arrange
    const mutex = new Mutex(new MemoryStore());
    const holder = Promise.withResolvers<void>();
    const holding = mutex.acquire('warehouse-writer', () => holder.promise);
    const release = Promise.withResolvers<void>();
    let running = false;
    await using selector = LeaderSelector.start(mutex.key('warehouse-writer'), {
      takeLeadership: async () => {
        running = true;
        await release.promise;
        running = false;
      },
    });

    // Act and assert
    await afterPendingReactions();
    assert.equal(selector.hasLeadership, false, 'While it waits');
    holder.resolve();
    await holding;
    await waitFor(() => assert.equal(running, true), { signal: t.signal });
    assert.equal(selector.hasLeadership, true, 'While the task runs');
    release.resolve();
    await waitFor(() => assert.equal(running, false), { signal: t.signal });
    await afterPendingReactions();
    assert.equal(selector.hasLeadership, false, 'After the task returned');
  });

  test('requeue returns false while a round waits for the key, while it runs, and during the back-off', async (t) => {
    // Arrange
    const emitWarning = t.mock.method(process, 'emitWarning', () => {});
    const clock = createClock();
    const store = testStore();
    const holder = Promise.withResolvers<void>();
    const holding = store.mutex.acquire(
      'warehouse-writer',
      () => holder.promise,
    );
    let rounds = 0;
    await using selector = LeaderSelector.start(
      store.mutex.key('warehouse-writer'),
      {
        takeLeadership: async (_lease, signal) => {
          rounds++;
          if (rounds === 1) {
            await aborted(signal);
            return;
          }
          await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock } },
    );

    // Act and assert
    assert.equal(selector.requeue(), false, 'While it waits for the key');
    holder.resolve();
    await holding;
    await waitFor(() => assert.equal(rounds, 1), { signal: t.signal });
    assert.equal(selector.requeue(), false, 'While the task runs');
    store.failNext(new Error('The lock server is down'));
    selector.interruptLeadership();
    await waitFor(() => assert.equal(emitWarning.mock.callCount(), 1), {
      signal: t.signal,
    });
    assert.equal(selector.requeue(), false, 'During the back-off');
    await clock.tickAsync(1000);
    await waitFor(() => assert.equal(rounds, 2), { signal: t.signal });
  });
});

describe('Over a socket store', () => {
  test(
    'two selectors of one directory lead one at a time, and the dispose of the leader hands the key to the other',
    onUnixSockets,
    async (t) => {
      // Arrange: two app instances on one host.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using firstStore = new SocketStore(directory.path, {
        clock: globalThis,
      });
      await using secondStore = new SocketStore(directory.path, {
        clock: globalThis,
      });
      const leads: Array<{ instance: string; lease: FencedLease }> = [];
      const writer = (
        instance: string,
      ): LeaderSelectorListener<FencedLease> => ({
        takeLeadership: async (lease, signal) => {
          leads.push({ instance, lease });
          await untilStopped(signal);
        },
      });
      const autoRequeue = { backoff, clock: globalThis };
      const first = LeaderSelector.start(
        new Mutex(firstStore).key('warehouse-writer'),
        writer('first'),
        { autoRequeue },
      );
      await waitFor(() => assert.equal(leads.length, 1), { signal: t.signal });
      await using second = LeaderSelector.start(
        new Mutex(secondStore).key('warehouse-writer'),
        writer('second'),
        { autoRequeue },
      );
      await delay(settle);
      assert.equal(
        leads.length,
        1,
        'The second must wait while the first leads',
      );
      assert.equal(second.hasLeadership, false);

      // Act
      await first[Symbol.asyncDispose]();

      // Assert
      await waitFor(() => assert.equal(leads.length, 2), {
        signal: t.signal,
      });
      assert.deepEqual(
        leads.map(({ instance }) => instance),
        ['first', 'second'],
      );
      assert.ok(leads[1]!.lease.token.isNewerThan(leads[0]!.lease.token));
      assert.equal(second.hasLeadership, true);
    },
  );
});

describe('Over an election', () => {
  test('with autoRequeue, the task gets the term, a resolved task resigns and campaigns again, and the dispose resigns', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const epochs: bigint[] = [];
    const selector = LeaderSelector.start(
      writerElection(directory.path),
      {
        takeLeadership: async (term, signal) => {
          epochs.push(term.epoch);
          if (epochs.length === 2) await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock: globalThis } },
    );

    // Act
    await waitFor(() => assert.equal(epochs.length, 2), { signal: t.signal });
    assert.equal(selector.hasLeadership, true);
    await selector[Symbol.asyncDispose]();

    // Assert
    assert.deepEqual(epochs, [1n, 2n]);
    await selector.ended;
    await using next = await writerElection(directory.path).campaign();
    assert.equal(next?.epoch, 3n, 'The dispose must resign the term');
  });

  test('without autoRequeue, a resolved task resigns, and the selector waits for requeue', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const epochs: bigint[] = [];
    await using selector = LeaderSelector.start(
      writerElection(directory.path),
      {
        takeLeadership: async (term) => {
          epochs.push(term.epoch);
        },
      },
    );
    await waitFor(() => assert.equal(epochs.length, 1), { signal: t.signal });

    // Act
    const other = await writerElection(directory.path).campaign({
      timeout: 10_000,
    });
    await other?.resign();

    // Assert
    assert.equal(other?.epoch, 2n, 'The selector must resign its term');
    assert.equal(selector.requeue(), true);
    await waitFor(() => assert.deepEqual(epochs, [1n, 3n]), {
      signal: t.signal,
    });
  });

  test('with autoRequeue, an interrupt resigns the term and campaigns again', async (t) => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const epochs: bigint[] = [];
    await using selector = LeaderSelector.start(
      writerElection(directory.path),
      {
        takeLeadership: async (term, signal) => {
          epochs.push(term.epoch);
          await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock: globalThis } },
    );
    await waitFor(() => assert.equal(epochs.length, 1), { signal: t.signal });

    // Act
    selector.interruptLeadership();

    // Assert
    await waitFor(() => assert.deepEqual(epochs, [1n, 2n]), {
      signal: t.signal,
    });
  });

  test('a task that fails resigns the term before the selector ends', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const failure = new Error('The warehouse write failed');

    // Act
    const selector = LeaderSelector.start(
      writerElection(directory.path),
      {
        takeLeadership: async () => {
          throw failure;
        },
      },
      { autoRequeue: { backoff, clock: globalThis } },
    );

    // Assert
    await assert.rejects(selector.ended, (error) => error === failure);
    await using next = await writerElection(directory.path).campaign();
    assert.equal(next?.epoch, 2n, 'The failed task must resign its term');
    await assert.rejects(
      selector[Symbol.asyncDispose](),
      (error) => error === failure,
    );
  });

  test('a dispose during a campaign behind another leader stops the campaign', async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    await using leader = await writerElection(directory.path).campaign();
    let ran = false;
    const selector = LeaderSelector.start(writerElection(directory.path), {
      takeLeadership: async () => {
        ran = true;
      },
    });
    await afterPendingReactions();

    // Act
    await selector[Symbol.asyncDispose]();

    // Assert
    await selector.ended;
    assert.equal(ran, false);
    assert.equal(leader?.signal.aborted, false);
  });

  test('without autoRequeue, a failed campaign ends the selector with the failure', async () => {
    // Arrange: the directory of the election is under a file, so it cannot be made.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const file = join(directory.path, 'not-a-directory');
    await writeFile(file, '');
    let ran = false;

    // Act
    const selector = LeaderSelector.start(
      writerElection(join(file, 'writer')),
      {
        takeLeadership: async () => {
          ran = true;
        },
      },
    );

    // Assert
    const failure: unknown = await selector.ended.then(
      () => assert.fail('A failed campaign must end the selector'),
      (error: unknown) => error,
    );
    assert.ok(Error.isError(failure));
    await assert.rejects(
      selector[Symbol.asyncDispose](),
      (error) => error === failure,
    );
    assert.equal(ran, false);
  });

  test('with autoRequeue, a failed campaign warns, waits the back-off, and campaigns again', async (t) => {
    // Arrange
    const emitWarning = t.mock.method(process, 'emitWarning', () => {});
    const clock = createClock();
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const file = join(directory.path, 'not-a-directory');
    await writeFile(file, '');
    const epochs: bigint[] = [];
    await using selector = LeaderSelector.start(
      writerElection(join(file, 'writer')),
      {
        takeLeadership: async (term, signal) => {
          epochs.push(term.epoch);
          await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock } },
    );

    await waitFor(
      () => {
        assert.equal(emitWarning.mock.callCount(), 1);
        assert.equal(clock.countTimers(), 1);
      },
      { signal: t.signal },
    );
    const [warning] = emitWarning.mock.calls[0]!.arguments;
    assert.ok(warning instanceof LeaderSelectorWarning);
    assert.deepEqual(
      { ...warning },
      {
        name: 'LeaderSelectorWarning',
        code: 'ZUKHRUF_MUTEX_LEADER_SELECTOR_ACQUIRE_FAILED',
        detail: `election: ${join(file, 'writer', 'writer.lock')}`,
      },
    );
    assert.ok(Error.isError(warning.cause));

    // Act: the directory can be made now, and the back-off ends.
    await rm(file);
    await clock.tickAsync(1000);

    // Assert
    await waitFor(() => assert.deepEqual(epochs, [1n]), {
      signal: t.signal,
    });
  });
});

describe('The types', () => {
  test('the typecheck proves that start takes a key that always acquires or an election, each with the listener of its lease', () => {
    // `nx run mutex:typecheck` proves these lines; the body only builds them.
    const starts = (mutex: Mutex, election: SqliteElection) => {
      const overKey: LeaderSelectorListener<FencedLease> = {
        takeLeadership: async (lease) => void lease.token,
      };
      const overTerm: LeaderSelectorListener<Term> = {
        takeLeadership: async (term) => void term.epoch,
      };
      const options: LeaderSelectorOptions = {
        autoRequeue: { backoff, clock: globalThis },
      };
      const key = mutex.key('warehouse-writer');
      const giveUp = mutex.key('warehouse-writer', {
        mode: Modes.skipIfBusy(),
      });
      return [
        LeaderSelector.start(key, overKey, options),
        LeaderSelector.start(election, overTerm, options),
        // @ts-expect-error a key whose mode may give up has no round without a grant
        LeaderSelector.start(giveUp, overKey),
        // @ts-expect-error a key gives its task a fenced lease, not a term
        LeaderSelector.start(key, overTerm),
      ];
    };

    assert.equal(typeof starts, 'function');
  });
});
