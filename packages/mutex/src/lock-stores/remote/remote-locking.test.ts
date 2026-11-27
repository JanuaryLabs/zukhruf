import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';

import type { Clock } from '@zukhruf/async';
import { untilAborted } from '@zukhruf/async';
import {
  CounterTokenSource,
  EpochExhaustedError,
  EpochTokenSource,
  type TokenSource,
} from '@zukhruf/fencing';
import { ConnectionSupervisor } from '@zukhruf/rpc';
import { waitFor } from '@zukhruf/testing/async';

import { grantedWithin } from '../../testing/granted-within.ts';
import {
  scriptedConnector,
  scriptedPeer,
} from '../../testing/scripted-peer.ts';
import { settle } from '../../testing/timing.ts';
import { tokensThatFailOnce } from '../../testing/tokens-that-fail-once.ts';
import { LockCoordinator } from './lock-coordinator.ts';
import type { ClientConnector, LockRequest, LockResponse } from './protocol.ts';
import { RemoteLockClient } from './remote-lock-client.ts';

function clientOver(connector: ClientConnector) {
  return new RemoteLockClient(new ConnectionSupervisor(connector));
}

/** A coordinator's end that grants every acquire and try at once. */
function grantingPeer() {
  let tokens = 0;
  const peer = scriptedPeer<LockRequest, LockResponse>(async (request) => {
    if (request.op === 'acquire' || request.op === 'try') {
      queueMicrotask(() =>
        peer.deliver({ op: 'granted', id: request.id, token: `${++tokens}` }),
      );
    }
  });
  return peer;
}

/**
 * A coordinator that started after a failover. It recovers `sessions`, each
 * session id with its lease duration in milliseconds, as a lock server does
 * with the sessions that it found recorded, and `connect` serves a scripted
 * peer of one session.
 */
function coordinatorAfterFailover(
  sessions: Record<string, number>,
  clock: Clock,
  tokens: TokenSource = new CounterTokenSource(),
) {
  const coordinator = new LockCoordinator({
    tokens,
    recovery: { sessions: new Map(Object.entries(sessions)), clock },
  });
  const connect = (session: string) => {
    const peer = scriptedPeer<LockResponse, LockRequest>();
    coordinator.serve(peer.connection, session);
    return peer;
  };
  return { coordinator, connect };
}

/** Whether `peer` was answered `granted` for request `id`. */
const grantedTo = (
  peer: ReturnType<typeof scriptedPeer<LockResponse, LockRequest>>,
  id: string,
) =>
  peer.sent.some((response) => response.op === 'granted' && response.id === id);

describe('A coordinator that recovers the sessions of the term before', () => {
  test('a holder that reasserts long after the failover, within the lease duration of its session, keeps its key, and a waiter is granted only after the release', async (t) => {
    // Arrange: two recorded sessions with the default lease duration.
    const clock = createClock();
    const { connect } = coordinatorAfterFailover(
      { holder: 15_000, waiter: 15_000 },
      clock,
    );
    const waiter = connect('waiter');
    waiter.deliver({ op: 'reasserted' });
    waiter.deliver({ op: 'acquire', id: 'w', key: 'product:42' });

    // Act: the holder reconnects 5 seconds after the failover.
    await clock.tickAsync(5000);
    const holder = connect('holder');
    holder.deliver({ op: 'reassert', id: 'h', key: 'product:42', token: '5' });
    holder.deliver({ op: 'reasserted' });
    await delay(settle);
    const beforeRelease = [...waiter.sent];
    holder.deliver({ op: 'release', id: 'h' });

    // Assert
    assert.deepEqual(
      holder.sent,
      [],
      'A holder that reasserts within its lease duration must keep its key',
    );
    assert.deepEqual(
      beforeRelease,
      [],
      'No waiter may get the key while its holder still has it',
    );
    await waitFor(
      () =>
        assert.ok(
          grantedTo(waiter, 'w'),
          'The waiter must get the key after the release',
        ),
      { signal: t.signal },
    );
  });

  test('a new leader grants nothing until each recorded session sent its marker', async (t) => {
    // Arrange
    const clock = createClock();
    const { coordinator, connect } = coordinatorAfterFailover(
      { first: 15_000, second: 15_000 },
      clock,
    );
    const first = connect('first');
    first.deliver({ op: 'reassert', id: 'f', key: 'report:daily', token: '5' });
    first.deliver({ op: 'reasserted' });

    // Act: a key that nobody holds is asked for while the second session has not sent its marker.
    const other = coordinator.acquire('product:42');
    const beforeSecond = await grantedWithin(other, settle);
    // The second session holds no key, so it sends only the marker.
    connect('second').deliver({ op: 'reasserted' });

    // Assert
    assert.equal(
      beforeSecond,
      'waiting',
      'Nothing may be granted while a recorded session may still reassert',
    );
    // The last marker must end the recovery
    await untilAborted(other, t.signal);
    assert.deepEqual(first.sent, [], 'The reasserted key must stay held');
  });

  test('a session that misses its lease duration is fenced', async (t) => {
    // Arrange: a session that stays silent, as a frozen process does, and a slow session with a longer lease.
    const clock = createClock();
    const { coordinator, connect } = coordinatorAfterFailover(
      { frozen: 500, slow: 15_000 },
      clock,
      new EpochTokenSource(2n),
    );
    const staleToken = String((1n << 32n) | 7n);
    const waiter = coordinator.acquire('product:42');

    // Act: the lease duration of the frozen session ends while the slow session still recovers.
    await clock.tickAsync(499);
    const beforeDeadline = await grantedWithin(waiter, settle);
    await clock.tickAsync(1);
    const late = connect('frozen');
    // Its marker never comes: only the deadline can end its recovery.
    late.deliver({
      op: 'reassert',
      id: 'h',
      key: 'product:42',
      token: staleToken,
    });
    await waitFor(
      () =>
        assert.ok(late.sent.length > 0, 'The late reassert must be answered'),
      { signal: t.signal },
    );
    connect('slow').deliver({ op: 'reasserted' });
    const lease = await untilAborted(waiter, t.signal);

    // Assert
    assert.equal(
      beforeDeadline,
      'waiting',
      'The recovery must wait for the session until its lease duration ends',
    );
    assert.deepEqual(
      late.sent,
      [{ op: 'rejected', id: 'h' }],
      'A reassert after the lease duration of its session must be rejected, also while the recovery goes on',
    );
    assert.ok(
      lease.token.value > BigInt(staleToken),
      `The waiter's token ${lease.token} must be higher than the fenced holder's ${staleToken}`,
    );
  });

  test('a reassert of a session that the listing did not find is rejected', async (t) => {
    // Arrange
    const clock = createClock();
    const { coordinator, connect } = coordinatorAfterFailover(
      { recorded: 15_000 },
      clock,
    );
    const stranger = connect('unrecorded');

    // Act
    stranger.deliver({
      op: 'reassert',
      id: 's',
      key: 'product:42',
      token: '9',
    });
    stranger.deliver({ op: 'reasserted' });
    connect('recorded').deliver({ op: 'reasserted' });

    // Assert: the key is free once the recorded session ended its recovery.
    await waitFor(
      () =>
        assert.deepEqual(
          stranger.sent,
          [{ op: 'rejected', id: 's' }],
          'A session that was not recorded holds no key of an earlier term',
        ),
      { signal: t.signal },
    );
    // A rejected claim must not keep the key
    await untilAborted(coordinator.acquire('product:42'), t.signal);
  });

  test('a child of an IPC coordinator that sends the marker keeps its keys and gets its answers as before', async (t) => {
    // Arrange: a coordinator with no recovery, as an IPC coordinator or a worker coordinator makes, and a child that holds a key.
    const coordinator = new LockCoordinator({
      tokens: new CounterTokenSource(),
    });
    const child = scriptedPeer<LockResponse, LockRequest>();
    coordinator.serve(child.connection);
    child.deliver({ op: 'reasserted' });
    child.deliver({ op: 'acquire', id: 'a', key: 'product:42' });
    await waitFor(
      () => assert.ok(grantedTo(child, 'a'), 'The child must get the key'),
      { signal: t.signal },
    );

    // Act: the child sends the marker again, as its client does after each connect, then looks.
    child.deliver({ op: 'reasserted' });
    child.deliver({ op: 'isHeld', id: 'look', key: 'product:42' });
    const waiter = coordinator.acquire('product:42');
    await waitFor(
      () =>
        assert.ok(
          child.sent.some((response) => response.id === 'look'),
          'The child must get the answer to its look',
        ),
      { signal: t.signal },
    );

    // Assert: nothing answers the marker, and the child keeps its key.
    assert.deepEqual(child.sent, [
      { op: 'granted', id: 'a', token: '1' },
      { op: 'held', id: 'look', held: true },
    ]);
    assert.equal(
      await grantedWithin(waiter, settle),
      'waiting',
      'The child must keep its key after the marker',
    );
    assert.equal(child.closes, 0, 'The marker must not close the connection');
    child.deliver({ op: 'release', id: 'a' });
    // The key must pass on once the child releases it
    await untilAborted(waiter, t.signal);
  });
});

describe('Claims that a coordinator registers in the same turn as another event', () => {
  // Kept as a double: two real connections cannot deliver in one turn; socket-store-coordinator.test.ts covers two claims in one write.
  test('a claim outranked while it is being registered gives the key to the newer claim', async (t) => {
    // Arrange
    const clock = createClock();
    const { coordinator, connect } = coordinatorAfterFailover(
      { older: 15_000, newer: 15_000 },
      clock,
    );
    const older = connect('older');
    const newer = connect('newer');

    // Act: both holders reassert in one turn, so the older claim is outranked before it is registered.
    older.deliver({ op: 'reassert', id: 'o', key: 'product:42', token: '5' });
    newer.deliver({ op: 'reassert', id: 'n', key: 'product:42', token: '9' });
    older.deliver({ op: 'reasserted' });
    newer.deliver({ op: 'reasserted' });
    const waiter = coordinator.acquire('product:42');

    // Assert: the older holder stays connected, yet the key passes to the newer holder and then to the waiter.
    assert.equal(
      await grantedWithin(waiter, settle),
      'waiting',
      'The newer holder must have the key after the recovery',
    );
    newer.deliver({ op: 'release', id: 'n' });
    // An outranked claim must not keep the key after the newer holder releases it
    await untilAborted(waiter, t.signal);
    assert.deepEqual(older.sent, [{ op: 'rejected', id: 'o' }]);
  });

  // Kept as a double: over a real socket the close arrives after the claim resolves, so only a double makes a claim resolve after its peer left.
  test('a peer that disconnects right after it reasserts does not keep the key', async (t) => {
    // Arrange
    const clock = createClock();
    const { coordinator, connect } = coordinatorAfterFailover(
      { holder: 15_000 },
      clock,
    );
    const holder = connect('holder');

    // Act: the peer reasserts, sends its marker, and disconnects in the same turn.
    holder.deliver({ op: 'reassert', id: 'h', key: 'product:42', token: '5' });
    holder.deliver({ op: 'reasserted' });
    holder.drop();

    // Assert: once the recovery ends, the key is free.
    // A peer that left must not keep the key it reasserted
    await untilAborted(coordinator.acquire('product:42'), t.signal);
  });
});

describe('Remote lock client connection lifecycle', () => {
  // Kept as a double: a real connection reports its drop later, never inside send(); socket-store-reconnect.test.ts covers a drop after the send.
  test('an acquire whose connection drops while it is sent is sent again once on the next connection', async (t) => {
    // Arrange: the first connection drops during the send of the acquire.
    const { connector, calls } = scriptedConnector<LockRequest>();
    const client = clientOver(connector);
    const first = scriptedPeer<LockRequest, LockResponse>(async () => {
      first.drop();
    });
    const second = grantingPeer();
    const acquiring = client.acquire('product:42');
    await waitFor(
      () => assert.ok(calls.length === 1, 'The client must connect'),
      { signal: t.signal },
    );

    try {
      // Act
      calls[0]!.resolve(first.connection);
      await waitFor(
        () => assert.ok(calls.length === 2, 'The client must reconnect'),
        { signal: t.signal },
      );
      calls[1]!.resolve(second.connection);
      const lease = await acquiring;

      // Assert
      assert.ok(lease, 'The acquire must be granted on the next connection');
      assert.deepEqual(
        second.sent.map((request) => request.op),
        ['reasserted', 'acquire'],
        'The acquire must be sent again exactly once, after the end-of-reasserts marker',
      );
    } finally {
      await client.close();
    }
  });
});

describe('A request whose token cannot be minted', () => {
  // Kept as a double: only a scripted peer shows that the coordinator never closes the connection.
  test('an acquire is answered failed, the connection stays, and the same request is granted when it is sent again', async (t) => {
    // Arrange
    const coordinator = new LockCoordinator({
      tokens: tokensThatFailOnce(
        new Error('The token file could not be written.'),
      ),
    });
    const peer = scriptedPeer<LockResponse, LockRequest>();
    coordinator.serve(peer.connection);

    // Act
    peer.deliver({ op: 'acquire', id: 'a', key: 'product:42' });
    await waitFor(
      () =>
        assert.ok(
          peer.sent.length === 1,
          'The coordinator must answer the acquire',
        ),
      { signal: t.signal },
    );
    peer.deliver({ op: 'acquire', id: 'a', key: 'product:42' });
    await waitFor(
      () =>
        assert.ok(
          peer.sent.length === 2,
          'The coordinator must answer the acquire that is sent again',
        ),
      { signal: t.signal },
    );

    // Assert: the peer learns why, keeps its connection, and gets the free key on the next try.
    assert.deepEqual(peer.sent, [
      {
        op: 'failed',
        id: 'a',
        message: 'The token file could not be written.',
      },
      { op: 'granted', id: 'a', token: '1' },
    ]);
    assert.equal(peer.closes, 0, 'A failed mint must not close the connection');
  });

  test('a reassertion is rejected, and a later claim of the same key is accepted', async (t) => {
    // Arrange
    const clock = createClock();
    const { coordinator, connect } = coordinatorAfterFailover(
      { failed: 15_000, later: 15_000 },
      clock,
      tokensThatFailOnce(new Error('The token file could not be written.')),
    );
    const failed = connect('failed');
    const later = connect('later');

    // Act: the newer claim fails to mint, then an older claim of the same key arrives.
    failed.deliver({ op: 'reassert', id: 'f', key: 'product:42', token: '9' });
    await waitFor(
      () =>
        assert.ok(
          failed.sent.length === 1,
          'The coordinator must answer the failed reassertion',
        ),
      { signal: t.signal },
    );
    later.deliver({ op: 'reassert', id: 'l', key: 'product:42', token: '5' });
    failed.deliver({ op: 'reasserted' });
    later.deliver({ op: 'reasserted' });
    const waiter = coordinator.acquire('product:42');

    // Assert: the failed holder is told it lost the key, and the later claim keeps it.
    assert.deepEqual(failed.sent, [{ op: 'rejected', id: 'f' }]);
    assert.equal(
      failed.closes,
      0,
      'A failed mint must not close the connection',
    );
    assert.equal(
      await grantedWithin(waiter, settle),
      'waiting',
      'The later claim must hold the key after the recovery',
    );
    assert.deepEqual(later.sent, [], 'The later claim must not be refused');
    later.deliver({ op: 'release', id: 'l' });
    // The key must pass on once the later claim releases it
    await untilAborted(waiter, t.signal);
  });
});

describe('A request whose epoch has no tokens left', () => {
  // Kept as a double: no test can mint 2^32 tokens, so the token source throws what EpochTokenSource throws at its end.
  test('the coordinator reports the exhausted epoch once, answers nothing, and keeps the connection', async (t) => {
    // Arrange
    const exhausted: TokenSource = {
      async next() {
        throw new EpochExhaustedError(7n);
      },
    };
    let reports = 0;
    const coordinator = new LockCoordinator({
      tokens: exhausted,
      onTokensExhausted: () => reports++,
    });
    const peer = scriptedPeer<LockResponse, LockRequest>();
    coordinator.serve(peer.connection);

    // Act
    peer.deliver({ op: 'acquire', id: 'a', key: 'product:42' });
    await waitFor(
      () =>
        assert.ok(
          reports === 1,
          'The coordinator must report the exhausted epoch',
        ),
      { signal: t.signal },
    );

    // Assert: the leader steps down instead, so the request is answered as on a lost connection.
    assert.equal(reports, 1, 'The coordinator must report the exhausted epoch');
    assert.deepEqual(
      peer.sent,
      [],
      'The coordinator must not answer the request',
    );
    assert.equal(
      peer.closes,
      0,
      'The step-down closes the connection, not the session',
    );
  });
});
