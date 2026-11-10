import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { TestContext } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import type { Clock } from '@zukhruf/async';
import { settleWithin } from '@zukhruf/testing/async';
import { describe, test } from '@zukhruf/testing/node';

import { LeaseLostError } from '../../index.ts';
import type { LockStore } from '../../mutex/lock-store.ts';
import { Mutex } from '../../mutex/mutex.ts';
import { factTimeout } from '../fact-timeout.ts';
import { hold } from '../hold.ts';
import { uniqueKey } from './keys.ts';
import type { Host, Subject } from './subject.ts';

/** A store whose locks live on a session of a server, behind a TCP proxy. */
export interface Partitioned extends AsyncDisposable {
  readonly store: LockStore;
  /** Stops forwarding in both directions and closes no socket: the network stopped without a reset. */
  partition(): void;
}

/** A store that beats a heartbeat to its server, and can be cut off from it. */
export interface Partitionable {
  /** The heartbeat interval of each store that `partitionable` opens. */
  readonly heartbeatInterval: number;
  /** A store over `location` that reaches its server through a proxy and beats on `clock`. */
  partitionable(location: string, clock: Clock): Promise<Partitioned>;
}

/** A store whose holder's session the server administrator can end. */
export interface Watched extends AsyncDisposable {
  readonly store: LockStore;
  /** Ends, from another session, the session that holds the lease. */
  killHolder(): Promise<void>;
}

/** A store over one session that hides the end of its connection and connects again. */
export interface Reconnecting extends AsyncDisposable {
  readonly store: LockStore;
  /** Ends the session's connection from another session. */
  kill(): Promise<void>;
  /** Resolves when the new connection is up. */
  readonly reconnected: Promise<void>;
  /** Lets the queries on the new connection run. */
  resume(): void;
}

/** What the session tests reach on the server of a session lock store. */
export interface SessionControl {
  /** A store over `location` with heartbeat `heartbeatInterval`, whose holder's session can be ended. */
  watched(location: string, heartbeatInterval: number): Promise<Watched>;
  /** A store over `location` with heartbeat `heartbeatInterval` whose one session reconnects silently. */
  silentlyReconnecting(
    location: string,
    heartbeatInterval: number,
  ): Promise<Reconnecting>;
  /** Resolves once a session of the database at `location` waits in the server's lock queue. */
  untilASessionWaits(t: TestContext, location: string): Promise<void>;
}

/** A store over a pool of sessions. */
export interface Pooled extends AsyncDisposable {
  readonly store: LockStore;
  /** Borrows the next session of the pool and tells whether it still holds a lock. */
  nextBorrowerHoldsALock(): Promise<boolean>;
}

/** A session lock store whose sessions go back to a pool after a release. */
export interface PoolControl {
  /** A store over a pool of at most `size` sessions to the database at `location`. */
  pooled(location: string, size: number): Pooled;
}

/** A store that beats a heartbeat: a held key survives one silent interval and is lost at two. */
export function leaseLoss<H extends Host>(
  store: Subject<H>,
  partitionable: Partitionable,
): void {
  describe(`Lease loss with ${store.name}`, () => {
    test('a held key is still held one heartbeat interval after the server stops answering, and lost at two, on the clock of the store', async (t) => {
      // Arrange: the store reaches the server through a proxy, and holds a key.
      await using fixture = await store.fixture(process.env);
      const clock = createClock();
      await using cut = await partitionable.partitionable(
        fixture.location,
        clock,
      );
      const mutex = new Mutex(cut.store);
      const holding = Promise.withResolvers<AbortSignal>();
      const run = mutex.acquire(uniqueKey(), async (lease) => {
        // The network stops silently while the task runs.
        cut.partition();
        holding.resolve(lease.signal);
        await once(lease.signal, 'abort');
      });
      const lost = assert.rejects(run, LeaseLostError);
      const lease = await holding.promise;
      // The next heartbeat waits one interval on the clock.
      await t.waitFor(() => assert.equal(clock.countTimers(), 1), {
        timeout: factTimeout,
      });

      // Act: the heartbeat asks, and the partition holds the answer.
      await clock.tickAsync(partitionable.heartbeatInterval);
      // The time limit of the heartbeat waits on the clock.
      await t.waitFor(() => assert.equal(clock.countTimers(), 1), {
        timeout: factTimeout,
      });
      const heldAfterOne = !lease.aborted;
      await clock.tickAsync(partitionable.heartbeatInterval);

      // Assert
      assert.equal(
        heldAfterOne,
        true,
        'The heartbeat must wait for its answer',
      );
      assert.equal(
        lease.aborted,
        true,
        'The holder must learn that its session may be gone',
      );
      await lost;
    });
  });
}

/** A store whose locks live on a session of a server. */
export function sessions<H extends Host>(
  store: Subject<H>,
  control: SessionControl,
): void {
  describe(`Sessions with ${store.name}`, () => {
    test('a killed session loses its lease before the next heartbeat', async () => {
      // Arrange: a heartbeat far longer than the wait, so only the end of the session can tell the holder.
      await using fixture = await store.fixture(process.env);
      await using watched = await control.watched(fixture.location, 60_000);
      const lost = Promise.withResolvers<AbortSignal>();

      // Act
      const run = new Mutex(watched.store).acquire(
        uniqueKey(),
        async (lease) => {
          // Listen first: the end of the session can abort the lease before the kill answers.
          const aborted = once(lease.signal, 'abort');
          await watched.killHolder();
          await aborted;
          lost.resolve(lease.signal);
        },
      );

      // Assert
      const signal = await settleWithin(
        lost.promise,
        'the lease of a killed session to abort',
        factTimeout,
      );
      assert.ok(
        signal.reason instanceof LeaseLostError,
        'A session that the server ended must abort the lease',
      );
      await assert.rejects(run, LeaseLostError);
    });

    test('a session that reconnects silently loses its lease', async () => {
      // Arrange: the holder's session hides the end of its connection and connects again.
      // The store sees the new connection only after another store took the key, and
      // a heartbeat interval longer than a reconnect and a take keeps its beat in time.
      await using fixture = await store.fixture(process.env);
      await using reconnecting = await control.silentlyReconnecting(
        fixture.location,
        3000,
      );
      await using other = store.open(fixture.location);
      const key = uniqueKey();
      const handle = await reconnecting.store.acquire(key);
      await using taken = new AsyncDisposableStack();
      try {
        // Act: the server ends the holder's connection, which frees the key, and another store takes the key.
        const lost = once(handle.signal, 'abort');
        await reconnecting.kill();
        await reconnecting.reconnected;
        const heldAfterReconnect = !handle.signal.aborted;
        const lease = await other.store.tryAcquire(key);
        if (lease) taken.use(lease);
        reconnecting.resume();

        // Assert: the heartbeat asks whether this session holds the lock, not whether any session does.
        assert.ok(
          heldAfterReconnect,
          'The reconnect itself must not lose the lease',
        );
        assert.ok(lease, 'The ended connection must have freed the key');
        await settleWithin(
          lost,
          'the lease of a session that no longer holds the lock to abort',
          factTimeout,
        );
        const reason: unknown = handle.signal.reason;
        assert.ok(reason instanceof LeaseLostError);
        assert.match(String(reason.cause), /no longer holds the lock/);
      } finally {
        reconnecting.resume();
        await handle[Symbol.asyncDispose]();
      }
    });

    test('a cancelled waiter that the server grants later gives the key to the next waiter', async (t) => {
      // Arrange: a holder, and a waiter in another store that cancels while the server keeps its place in the queue.
      await using fixture = await store.fixture(process.env);
      await using holderHost = store.open(fixture.location);
      await using waiterHost = store.open(fixture.location);
      await using nextHost = store.open(fixture.location);
      const key = uniqueKey();
      const holder = await hold(new Mutex(holderHost.store), key);
      const cancel = new AbortController();
      const waiting = new Mutex(waiterHost.store).acquire(
        key,
        async () => 'ran',
        { signal: cancel.signal },
      );
      await control.untilASessionWaits(t, fixture.location);
      cancel.abort(new Error('cancelled'));
      await assert.rejects(waiting);

      // Act: the holder releases, so the server can grant the cancelled waiter's place first.
      await holder.release();
      const next = new Mutex(nextHost.store).acquire(
        key,
        async () => 'granted' as const,
      );

      // Assert
      assert.equal(
        await settleWithin(next, 'the next waiter to get the key', factTimeout),
        'granted',
        'A grant to a cancelled waiter must be released, so the next waiter gets the key',
      );
    });

    test('a cancelled acquire rejects with the reason of its signal', async (t) => {
      // Arrange: another store holds the key, and a waiter waits for it on the server.
      await using fixture = await store.fixture(process.env);
      await using holderHost = store.open(fixture.location);
      await using waiterHost = store.open(fixture.location);
      const key = uniqueKey();
      const holder = await hold(new Mutex(holderHost.store), key);
      try {
        const cancel = new AbortController();
        const reason = new Error('cancelled');
        const waiting = waiterHost.store.acquire(key, {
          signal: cancel.signal,
        });
        const outcome = waiting.then(
          async (lease) => {
            await lease[Symbol.asyncDispose]();
            return 'granted' as const;
          },
          (error: unknown) => error,
        );
        await control.untilASessionWaits(t, fixture.location);

        // Act
        cancel.abort(reason);

        // Assert
        assert.equal(
          await settleWithin(
            outcome,
            'the cancelled acquire to settle',
            factTimeout,
          ),
          reason,
        );
      } finally {
        await holder.release();
      }
    });

    test('two stores in different databases on one server do not share a key', async () => {
      // Arrange: two databases on one server, and a holder of the key in the first.
      await using first = await store.fixture(process.env);
      await using second = await store.fixture(process.env);
      await using firstHost = store.open(first.location);
      await using secondHost = store.open(second.location);
      const key = uniqueKey();
      const holder = await hold(new Mutex(firstHost.store), key);
      try {
        // Act
        const other = await secondHost.store.tryAcquire(key);
        await using _lease = other;

        // Assert
        assert.ok(
          other,
          'A key held in one database must be free in another database of the same server',
        );
      } finally {
        await holder.release();
      }
    });
  });
}

/** A session lock store whose sessions go back to a pool after a release. */
export function pools<H extends Host>(
  store: Subject<H>,
  control: SessionControl & PoolControl,
): void {
  describe(`Pooled sessions with ${store.name}`, () => {
    test('the next acquire after a cancel gets the only session of the pool', async (t) => {
      // Arrange: another store holds the key, and the waiter's only session waits for it.
      await using fixture = await store.fixture(process.env);
      await using holderHost = store.open(fixture.location);
      await using waiterPool = control.pooled(fixture.location, 1);
      const key = uniqueKey();
      const holder = await hold(new Mutex(holderHost.store), key);
      const waiter = new Mutex(waiterPool.store);
      const cancel = new AbortController();
      const reason = new Error('cancelled');
      const outcome = waiter
        .acquire(key, async () => 'ran', { signal: cancel.signal })
        .then(
          (value) => value,
          (error: unknown) => error,
        );
      await control.untilASessionWaits(t, fixture.location);
      cancel.abort(reason);
      await holder.release();

      // Act
      const next = waiter.acquire(key, async () => 'ran' as const);

      // Assert: first the next acquire, because a cancel that keeps the only session never lets it settle.
      assert.equal(
        await settleWithin(
          next,
          'the next acquire on the only session',
          factTimeout,
        ),
        'ran',
        'A cancel must give back its turn and its session',
      );
      assert.equal(
        await outcome,
        reason,
        'The cancelled call must reject with the reason of its signal',
      );
    });

    test('a released key leaves no lock on the session that goes back to the pool', async () => {
      // Arrange: a pool of one session.
      await using fixture = await store.fixture(process.env);
      await using pooled = control.pooled(fixture.location, 1);
      const lease = await pooled.store.acquire(uniqueKey());

      // Act
      await lease[Symbol.asyncDispose]();

      // Assert
      assert.equal(
        await pooled.nextBorrowerHoldsALock(),
        false,
        'The next borrower of the session must not hold the released lock',
      );
    });
  });
}
