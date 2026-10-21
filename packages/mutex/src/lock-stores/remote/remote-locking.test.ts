import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { CounterTokenSource, type TokenSource } from '@zukhruf/fencing';

import {
  scriptedConnector,
  scriptedPeer,
} from '../../testing/scripted-peer.ts';
import { settle } from '../../testing/store-cases.ts';
import { waitUntil } from '../../testing/wait-until.ts';
import { ConnectionSupervisor } from './connection-supervisor.ts';
import type { ClientConnector } from './connector.ts';
import { LockCoordinator } from './lock-coordinator.ts';
import type { LockRequest, LockResponse } from './protocol.ts';
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

/** A coordinator that started after a failover, and a way to connect scripted peers to it. */
function coordinatorAfterFailover(graceWindow: number) {
  const coordinator = new LockCoordinator({
    tokens: new CounterTokenSource(),
    graceWindow,
  });
  const connect = () => {
    const peer = scriptedPeer<LockResponse, LockRequest>();
    coordinator.serve(peer.connection);
    return peer;
  };
  return { coordinator, connect };
}

/** Resolves `'granted'` if `lease` arrives within `milliseconds`, otherwise `'waiting'`. */
function grantedWithin(lease: Promise<unknown>, milliseconds: number) {
  return Promise.race([
    lease.then(() => 'granted' as const),
    delay(milliseconds, 'waiting' as const, { ref: false }),
  ]);
}

describe('Claims that a coordinator registers in the same turn as another event', () => {
  // Kept as a double: two real connections cannot deliver in one turn; socket-store-coordinator.test.ts covers two claims in one write.
  test('a claim outranked while it is being registered gives the key to the newer claim', async () => {
    // Arrange
    const graceWindow = 150;
    const { coordinator, connect } = coordinatorAfterFailover(graceWindow);
    const older = connect();
    const newer = connect();

    // Act: both holders reassert in one turn, so the older claim is outranked before it is registered.
    older.deliver({ op: 'reassert', id: 'o', key: 'product:42', token: '5' });
    newer.deliver({ op: 'reassert', id: 'n', key: 'product:42', token: '9' });
    const waiter = coordinator.acquire('product:42');

    // Assert: the older holder stays connected, yet the key passes to the newer holder and then to the waiter.
    assert.equal(
      await grantedWithin(waiter, graceWindow + 2 * settle),
      'waiting',
      'The newer holder must have the key after the grace window',
    );
    newer.deliver({ op: 'release', id: 'n' });
    assert.equal(
      await grantedWithin(waiter, 1000),
      'granted',
      'An outranked claim must not keep the key after the newer holder releases it',
    );
    assert.deepEqual(older.sent, [{ op: 'rejected', id: 'o' }]);
  });

  // Kept as a double: over a real socket the close arrives after the claim resolves, so only a double makes a claim resolve after its peer left.
  test('a peer that disconnects right after it reasserts does not keep the key', async () => {
    // Arrange
    const { coordinator, connect } = coordinatorAfterFailover(100);
    const holder = connect();

    // Act: the peer reasserts and disconnects in the same turn.
    holder.deliver({ op: 'reassert', id: 'h', key: 'product:42', token: '5' });
    holder.drop();

    // Assert: once the grace window ends, the key is free.
    assert.equal(
      await grantedWithin(coordinator.acquire('product:42'), 1000),
      'granted',
      'A peer that left must not keep the key it reasserted',
    );
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
    await waitUntil(t, () => calls.length === 1, 'The client must connect');

    try {
      // Act
      calls[0]!.resolve(first.connection);
      await waitUntil(t, () => calls.length === 2, 'The client must reconnect');
      calls[1]!.resolve(second.connection);
      const lease = await acquiring;

      // Assert
      assert.ok(lease, 'The acquire must be granted on the next connection');
      assert.deepEqual(
        second.sent.map((request) => request.op),
        ['acquire'],
        'The acquire must be sent again exactly once',
      );
    } finally {
      await client.close();
    }
  });
});

/** Counts tokens like CounterTokenSource, but its first mint fails, as a token file on a full disk would. */
function tokensThatFailOnce(failure: Error): TokenSource {
  const counter = new CounterTokenSource();
  let failed = false;
  return {
    async next(key) {
      if (failed) return counter.next(key);
      failed = true;
      throw failure;
    },
  };
}

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
    await waitUntil(
      t,
      () => peer.sent.length === 1,
      'The coordinator must answer the acquire',
    );
    peer.deliver({ op: 'acquire', id: 'a', key: 'product:42' });
    await waitUntil(
      t,
      () => peer.sent.length === 2,
      'The coordinator must answer the acquire that is sent again',
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

  test('a reassertion is rejected, and a later claim of the same key is accepted', async () => {
    // Arrange
    const graceWindow = 150;
    const coordinator = new LockCoordinator({
      tokens: tokensThatFailOnce(
        new Error('The token file could not be written.'),
      ),
      graceWindow,
    });
    const connect = () => {
      const peer = scriptedPeer<LockResponse, LockRequest>();
      coordinator.serve(peer.connection);
      return peer;
    };
    const failed = connect();
    const later = connect();

    // Act: the newer claim fails to mint, then an older claim of the same key arrives.
    failed.deliver({ op: 'reassert', id: 'f', key: 'product:42', token: '9' });
    await delay(settle);
    later.deliver({ op: 'reassert', id: 'l', key: 'product:42', token: '5' });
    const waiter = coordinator.acquire('product:42');

    // Assert: the failed holder is told it lost the key, and the later claim keeps it.
    assert.deepEqual(failed.sent, [{ op: 'rejected', id: 'f' }]);
    assert.equal(
      failed.closes,
      0,
      'A failed mint must not close the connection',
    );
    assert.equal(
      await grantedWithin(waiter, graceWindow + 2 * settle),
      'waiting',
      'The later claim must hold the key after the grace window',
    );
    assert.deepEqual(later.sent, [], 'The later claim must not be refused');
    later.deliver({ op: 'release', id: 'l' });
    assert.equal(
      await grantedWithin(waiter, 1000),
      'granted',
      'The key must pass on once the later claim releases it',
    );
  });
});
