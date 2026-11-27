import assert from 'node:assert/strict';
import {
  setImmediate as afterPendingReactions,
  setTimeout as delay,
} from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';

import { Backoff } from '@zukhruf/async';
import {
  LeaderSelector,
  type LeaderSelectorListener,
  LeaderSelectorWarning,
  TermWarning,
} from '@zukhruf/election';
import {
  CounterTokenSource,
  EpochTokenSource,
  type TokenSource,
} from '@zukhruf/fencing';
import { TemporaryFiles } from '@zukhruf/fs';
import { LeaseController, LeaseLostError } from '@zukhruf/lease';
import { describe, test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';

import { type LockStore, Modes, Mutex, MutexElection } from './index.ts';
import { MemoryStore } from './lock-stores/memory/index.ts';
import { SocketStore } from './lock-stores/socket/index.ts';
import { onUnixSockets } from './testing/on-unix-sockets.ts';
import { settle } from './testing/timing.ts';

/** Waits 1 s, 2 s, 4 s and so on, with no jitter. */
const backoff = new Backoff({
  initial: 1000,
  multiplier: 2,
  max: 60_000,
  jitter: { kind: 'none' },
});

/** Holds the leadership until `signal` aborts, and then rejects with its reason, as a writer that runs until it is stopped. */
const untilStopped = (signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) => {
    signal.throwIfAborted();
    signal.addEventListener('abort', () => reject(signal.reason), {
      once: true,
    });
  });

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
 * a database store loses a lease when its session ends, or the first lease at
 * its grant, and can make the next try, wait or release fail, as a store
 * whose server is down. A store that does not hear a cancel grants a waiter
 * that already left, as a store whose cancel cannot reach its server. It
 * counts the tries and the waits.
 */
function testStore({
  hearsCancel = true,
  losesFirstGrant = false,
  tokens = new CounterTokenSource(),
}: {
  hearsCancel?: boolean;
  losesFirstGrant?: boolean;
  tokens?: TokenSource;
} = {}) {
  const inner = new MemoryStore({ tokens });
  const leases: LeaseController[] = [];
  const tryFailures: Error[] = [];
  const waitFailures: Error[] = [];
  const releaseFailures: Error[] = [];
  let tries = 0;
  let waits = 0;
  const losable = (
    key: string,
    handle: Awaited<ReturnType<LockStore['acquire']>>,
  ) => {
    const lease = new LeaseController(key);
    if (losesFirstGrant && leases.length === 0) lease.lose();
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
  };
  const store: LockStore = {
    acquire: async (key, options) => {
      waits++;
      const failure = waitFailures.shift();
      if (failure) throw failure;
      return losable(key, await inner.acquire(key, hearsCancel ? options : {}));
    },
    tryAcquire: async (key) => {
      tries++;
      const failure = tryFailures.shift();
      if (failure) throw failure;
      const handle = await inner.tryAcquire(key);
      return handle && losable(key, handle);
    },
    isHeld: (key) => inner.isHeld(key),
  };
  return {
    mutex: new Mutex(store),
    failNextTry: (failure: Error) => tryFailures.push(failure),
    failNextWait: (failure: Error) => waitFailures.push(failure),
    failNextRelease: (failure: Error) => releaseFailures.push(failure),
    loseLease: () => leases.at(-1)?.lose(),
    lastLease: () => leases.at(-1)?.signal,
    tries: () => tries,
    waits: () => waits,
  };
}

describe('A lost lease', () => {
  test('aborts the signal of the term with the loss of the store, and the resign after it never rejects and leaves the key free', async (t) => {
    // Arrange
    const store = testStore();
    const election = new MutexElection({
      key: store.mutex.key('warehouse-writer'),
      clock: globalThis,
    });
    const term = await election.campaign();
    assert.ok(term);

    // Act
    store.loseLease();

    // Assert
    assert.ok(term.signal.reason instanceof LeaseLostError);
    const { cause } = term.signal.reason;
    assert.ok(cause instanceof LeaseLostError);
    assert.equal(cause.subject, 'warehouse-writer');
    await term.resign();
    await waitFor(
      async () =>
        assert.equal(await store.mutex.isHeld('warehouse-writer'), false),
      { signal: t.signal },
    );
  });

  test('a grant whose lease the store already took away is no term: the campaign wins the next grant', async () => {
    // Arrange
    const store = testStore({ losesFirstGrant: true });
    const election = new MutexElection({
      key: store.mutex.key('warehouse-writer'),
      clock: globalThis,
    });

    // Act
    await using term = await election.campaign({ timeout: Infinity });

    // Assert
    assert.ok(term);
    assert.equal(term.epoch, 2n, 'The term is of the second grant');
    assert.equal(term.signal.aborted, false);
  });
});

describe('A campaign against a busy key', () => {
  test('with timeout 0, it tries once and resolves undefined at once, also when the key itself waits, and leaves no waiter behind', async (t) => {
    // Arrange: a key whose own acquire mode waits.
    const store = testStore();
    const holder = Promise.withResolvers<void>();
    const holding = store.mutex.acquire(
      'warehouse-writer',
      () => holder.promise,
    );
    const election = new MutexElection({
      key: store.mutex.key('warehouse-writer'),
      clock: globalThis,
    });

    // Act
    const campaign = election.campaign({ timeout: 0 });

    // Assert
    assert.equal(
      await settledSoon(campaign),
      true,
      'A campaign of timeout 0 must not wait',
    );
    assert.equal(await campaign, undefined);
    assert.deepEqual(
      { tries: store.tries(), waits: store.waits() },
      { tries: 1, waits: 1 },
      'One try, beside the wait of the holder',
    );
    holder.resolve();
    await holding;
    await waitFor(
      async () =>
        assert.equal(await store.mutex.isHeld('warehouse-writer'), false),
      { signal: t.signal },
    );
  });
});

describe('A campaign behind a holder', () => {
  void test.each(
    [
      ['waits', Modes.wait()],
      ['skips while busy', Modes.skipIfBusy()],
    ] as const,
    ([name, mode]) =>
      test(`over a key that ${name}, it waits in the line of the key, wins the grant when the holder leaves, and its resign frees the key`, async (t) => {
        // Arrange
        const store = testStore();
        const holder = Promise.withResolvers<void>();
        const holding = store.mutex.acquire(
          'warehouse-writer',
          () => holder.promise,
        );
        const election = new MutexElection({
          key: store.mutex.key('warehouse-writer', { mode }),
          clock: globalThis,
        });
        const campaign = election.campaign({ timeout: Infinity });
        assert.equal(await settledSoon(campaign), false);

        // Act
        holder.resolve();
        await holding;
        const term = await campaign;

        // Assert
        assert.ok(term);
        assert.deepEqual(
          { tries: store.tries(), waits: store.waits() },
          { tries: 1, waits: 2 },
          'One try and one wait, beside the wait of the holder',
        );
        assert.equal(await store.mutex.isHeld('warehouse-writer'), true);
        await term.resign();
        await waitFor(
          async () =>
            assert.equal(await store.mutex.isHeld('warehouse-writer'), false),
          { signal: t.signal },
        );
      }),
  );
});

describe('A campaign that stops while it waits', () => {
  void test.each(
    [
      ['its deadline passes', 'hears the cancel', true],
      ['its deadline passes', 'grants after the cancel', false],
      ['its caller aborts', 'hears the cancel', true],
      ['its caller aborts', 'grants after the cancel', false],
    ] as const,
    ([stop, store, hearsCancel]) =>
      test(`when ${stop}, over a store that ${store}, the campaign ends without a term, and the key goes to the next holder`, async (t) => {
        // Arrange
        const clock = createClock();
        const lockStore = testStore({ hearsCancel });
        const holder = Promise.withResolvers<void>();
        const holding = lockStore.mutex.acquire(
          'warehouse-writer',
          () => holder.promise,
        );
        const caller = new AbortController();
        const election = new MutexElection({
          key: lockStore.mutex.key('warehouse-writer'),
          clock,
        });
        const campaign = election.campaign({
          timeout: 1000,
          signal: caller.signal,
        });
        await waitFor(() => assert.equal(lockStore.waits(), 2), {
          signal: t.signal,
        });

        // Act
        const reason = new Error('The host stops');
        if (stop === 'its caller aborts') caller.abort(reason);
        else await clock.tickAsync(1000);

        // Assert
        if (stop === 'its caller aborts')
          await assert.rejects(campaign, (error) => error === reason);
        else assert.equal(await campaign, undefined);
        holder.resolve();
        await holding;
        await waitFor(
          async () =>
            assert.equal(
              await lockStore.mutex.isHeld('warehouse-writer'),
              false,
            ),
          { signal: t.signal },
        );
        await lockStore.mutex.acquire('warehouse-writer', async () => {});
      }),
  );
});

describe('A store that fails', () => {
  void test.each(
    [
      ['a try', 'failNextTry'],
      ['a wait', 'failNextWait'],
    ] as const,
    ([step, fail]) =>
      test(`in ${step} rejects the campaign with its failure, and the attempt keeps no hold of the key`, async (t) => {
        // Arrange: the key is busy, so the campaign waits after its try.
        const store = testStore();
        const holder = Promise.withResolvers<void>();
        const holding = store.mutex.acquire(
          'warehouse-writer',
          () => holder.promise,
        );
        const failure = new Error('The lock server is down');
        store[fail](failure);
        const election = new MutexElection({
          key: store.mutex.key('warehouse-writer'),
          clock: globalThis,
        });

        // Act
        const campaign = election.campaign({ timeout: Infinity });

        // Assert
        await assert.rejects(campaign, (error) => error === failure);
        holder.resolve();
        await holding;
        await waitFor(
          async () =>
            assert.equal(await store.mutex.isHeld('warehouse-writer'), false),
          { signal: t.signal },
        );
      }),
  );
});

describe('The resign', () => {
  test('a release that fails rejects the resign with that failure, once', async (t) => {
    // Arrange: the store frees the key, then reports that its release failed.
    const emitWarning = t.mock.method(process, 'emitWarning', () => {});
    const store = testStore();
    const failure = new Error(
      'The store lost its connection while it released the key',
    );
    store.failNextRelease(failure);
    const election = new MutexElection({
      key: store.mutex.key('warehouse-writer'),
      clock: globalThis,
    });
    const term = await election.campaign();
    assert.ok(term);

    // Act
    const resigning = term.resign();

    // Assert: a second give-up of the grant would reject with a SuppressedError, or warn.
    await assert.rejects(resigning, (error) => error === failure);
    await afterPendingReactions();
    assert.equal(emitWarning.mock.callCount(), 0);
  });

  test('a loss that comes while the term resigns does not reject the resign', async (t) => {
    // Arrange
    const store = testStore();
    const election = new MutexElection({
      key: store.mutex.key('warehouse-writer'),
      clock: globalThis,
    });
    const term = await election.campaign();
    assert.ok(term);

    // Act: the resign has begun to give the key up when the store takes it away.
    const resigning = term.resign();
    store.loseLease();

    // Assert
    await resigning;
    assert.ok(
      store.lastLease()?.reason instanceof LeaseLostError,
      'The loss landed before the release ended the lease',
    );
    assert.equal(term.signal.aborted, false, 'A resigned term is not lost');
    await waitFor(
      async () =>
        assert.equal(await store.mutex.isHeld('warehouse-writer'), false),
      { signal: t.signal },
    );
  });

  test('after a loss, a release that fails is a TermWarning of the election, with the failure in its cause', async (t) => {
    // Arrange
    const emitWarning = t.mock.method(process, 'emitWarning', () => {});
    const store = testStore();
    const failure = new Error('The store could not end the lost session');
    store.failNextRelease(failure);
    const election = new MutexElection({
      key: store.mutex.key('warehouse-writer'),
      clock: globalThis,
    });
    const term = await election.campaign();
    assert.ok(term);

    // Act
    store.loseLease();
    await term.resign();

    // Assert
    await waitFor(() => assert.equal(emitWarning.mock.callCount(), 1), {
      signal: t.signal,
    });
    const [warning] = emitWarning.mock.calls[0]!.arguments;
    assert.ok(warning instanceof TermWarning);
    assert.equal(warning.detail, 'election: warehouse-writer\nepoch: 1');
    const { cause } = warning;
    assert.ok(cause instanceof SuppressedError);
    assert.equal(cause.error, failure);
    assert.ok(cause.suppressed instanceof LeaseLostError);
  });
});

describe('The epoch and the clean shutdown', () => {
  test('the epoch of a term is the fencing token of its grant, also above 2^31, so it follows the tokens of the other holders', async () => {
    // Arrange: the tokens of a socket-store leader of epoch 7 are 7 << 32 | sequence.
    const store = testStore({ tokens: new EpochTokenSource(7n) });
    const election = new MutexElection({
      key: store.mutex.key('warehouse-writer'),
      clock: globalThis,
    });
    const epochs: bigint[] = [];

    // Act
    const first = await election.campaign();
    assert.ok(first);
    epochs.push(first.epoch);
    await first.resign();
    const other = await store.mutex.acquire(
      'warehouse-writer',
      async ({ token }) => token.value,
    );
    const second = await election.campaign();
    assert.ok(second);
    epochs.push(second.epoch);
    await second.resign();

    // Assert
    assert.deepEqual(
      [epochs[0], other, epochs[1]],
      [(7n << 32n) | 1n, (7n << 32n) | 2n, (7n << 32n) | 3n],
    );
  });

  test('afterCleanShutdown is false for the first term and after a clean resign, because a key keeps no note of a clean shutdown', async () => {
    // Arrange
    const store = testStore();
    const election = new MutexElection({
      key: store.mutex.key('warehouse-writer'),
      clock: globalThis,
    });
    const first = await election.campaign();
    assert.ok(first);

    // Act
    await first.resign({ clean: true });
    await using second = await election.campaign();

    // Assert
    assert.deepEqual(
      [first.afterCleanShutdown, second?.afterCleanShutdown],
      [false, false],
    );
  });
});

describe('A leader selector over a key', () => {
  test('the election has the name of the key, and a failed campaign warns with it', async (t) => {
    // Arrange
    const emitWarning = t.mock.method(process, 'emitWarning', () => {});
    const store = testStore();
    const failure = new Error('The lock server is down');
    store.failNextTry(failure);
    const election = new MutexElection({
      key: store.mutex.key('datahub/warehouse-writer'),
      clock: globalThis,
    });

    // Act
    await using _selector = LeaderSelector.start(
      election,
      { takeLeadership: (_term, signal) => untilStopped(signal) },
      { autoRequeue: { backoff, clock: createClock() } },
    );

    // Assert
    assert.equal(election.name, 'datahub/warehouse-writer');
    await waitFor(() => assert.equal(emitWarning.mock.callCount(), 1), {
      signal: t.signal,
    });
    const [warning] = emitWarning.mock.calls[0]!.arguments;
    assert.ok(warning instanceof LeaderSelectorWarning);
    assert.equal(warning.detail, 'election: datahub/warehouse-writer');
    assert.equal(warning.cause, failure);
  });

  test('with autoRequeue, a lost lease aborts the signal of the task with the loss, and the next round leads with a higher epoch', async (t) => {
    // Arrange
    const store = testStore();
    const epochs: bigint[] = [];
    const signals: AbortSignal[] = [];
    await using _selector = LeaderSelector.start(
      new MutexElection({
        key: store.mutex.key('warehouse-writer'),
        clock: globalThis,
      }),
      {
        takeLeadership: async (term, signal) => {
          epochs.push(term.epoch);
          signals.push(signal);
          await untilStopped(signal);
        },
      },
      { autoRequeue: { backoff, clock: createClock() } },
    );
    await waitFor(() => assert.equal(epochs.length, 1), { signal: t.signal });
    const firstLease = store.lastLease();

    // Act
    store.loseLease();

    // Assert
    await waitFor(() => assert.equal(epochs.length, 2), { signal: t.signal });
    const { reason } = signals[0]!;
    assert.ok(reason instanceof LeaseLostError);
    assert.equal(reason.cause, firstLease?.reason);
    assert.ok(epochs[1]! > epochs[0]!);
    assert.equal(signals[1]!.aborted, false);
  });
});

describe('Over a socket store', () => {
  test(
    'two selectors of one directory lead one at a time, and the dispose of the leader hands the key to the other, at a higher epoch',
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
      const leads: Array<{ instance: string; epoch: bigint }> = [];
      const writer = (instance: string): LeaderSelectorListener => ({
        takeLeadership: async (term, signal) => {
          leads.push({ instance, epoch: term.epoch });
          await untilStopped(signal);
        },
      });
      const election = (store: SocketStore) =>
        new MutexElection({
          key: new Mutex(store).key('warehouse-writer'),
          clock: globalThis,
        });
      const autoRequeue = { backoff, clock: globalThis };
      const first = LeaderSelector.start(
        election(firstStore),
        writer('first'),
        { autoRequeue },
      );
      await waitFor(() => assert.equal(leads.length, 1), { signal: t.signal });
      await using second = LeaderSelector.start(
        election(secondStore),
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
      assert.ok(leads[1]!.epoch > leads[0]!.epoch);
      assert.equal(second.hasLeadership, true);
    },
  );
});
