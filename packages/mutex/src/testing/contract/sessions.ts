import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { TestContext } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import { type Clock, untilAborted } from '@zukhruf/async';
import { describe, test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';

import { LeaseLostError } from '../../index.ts';
import type { LockStore } from '../../mutex/lock-store.ts';
import { Mutex } from '../../mutex/mutex.ts';
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
  /** Asks the server from another session which connection holds `key`, once the new connection is up. */
  holderOf(key: string): Promise<ReconnectHolder>;
}

/** The connections of a silent reconnect, and the connection that the server reports as the holder of a key. */
export interface ReconnectHolder {
  /** The id of the connection that the server ended. */
  readonly killed: number;
  /** The id of the new connection. */
  readonly reconnected: number;
  /** The id of the connection that holds the key, or `undefined` for a free key. */
  readonly holder: number | undefined;
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

function holderReport({ killed, reconnected, holder }: ReconnectHolder) {
  const holds =
    holder === undefined
      ? 'no connection holds the key'
      : `connection ${holder} holds the key`;
  return `the server ended connection ${killed}, the session reconnected as connection ${reconnected}, and the server reports that ${holds}`;
}

function holderQueryFailed(error: unknown) {
  return `the holder query failed: ${Error.isError(error) ? error.message : String(error)}`;
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
      await waitFor(() => assert.equal(clock.countTimers(), 1), {
        signal: t.signal,
      });

      // Act: the heartbeat asks, and the partition holds the answer.
      await clock.tickAsync(partitionable.heartbeatInterval);
      // The time limit of the heartbeat waits on the clock.
      await waitFor(() => assert.equal(clock.countTimers(), 1), {
        signal: t.signal,
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
    test('a killed session loses its lease before the next heartbeat', async (t) => {
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
      // The lease of a killed session aborts.
      const signal = await untilAborted(lost.promise, t.signal);
      assert.ok(
        signal.reason instanceof LeaseLostError,
        'A session that the server ended must abort the lease',
      );
      await assert.rejects(run, LeaseLostError);
    });

    test('a session that reconnects silently loses its lease', async (t) => {
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
        // Read before resume(), so the message tells who held the key at the take.
        // A holder query that fails puts its own error in the message, so the assertion still fails with its own words.
        const holder = lease
          ? undefined
          : await reconnecting
              .holderOf(key)
              .then(holderReport, holderQueryFailed);
        reconnecting.resume();

        // Assert: the heartbeat asks whether this session holds the lock, not whether any session does.
        assert.ok(
          heldAfterReconnect,
          'The reconnect itself must not lose the lease',
        );
        assert.ok(
          lease,
          `The ended connection must have freed the key${holder === undefined ? '' : `: ${holder}`}`,
        );
        // The lease of a session that no longer holds the lock aborts.
        await untilAborted(lost, t.signal);
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
        await untilAborted(next, t.signal),
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
        assert.equal(await untilAborted(outcome, t.signal), reason);
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
        await untilAborted(next, t.signal),
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
