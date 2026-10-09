import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { CounterTokenSource } from '../../fencing/counter-token-source.ts';
import {
  scriptedConnector,
  scriptedPeer,
} from '../../testing/scripted-peer.ts';
import { settle } from '../../testing/store-cases.ts';
import { waitUntil } from '../../testing/wait-until.ts';
import { ConnectionSupervisor } from './connection-supervisor.ts';
import type { ClientConnector } from './connector.ts';
import { LockCoordinator } from './lock-coordinator.ts';
import type { LockRequest, LockResponse, RequestEnvelope } from './protocol.ts';
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

describe('Remote locking protocol', () => {
  test('a resent acquire is granted once, and its release frees the key', async (t) => {
    // Arrange: a client's acquire reaches the coordinator twice, as after a reconnect.
    const coordinator = new LockCoordinator({
      tokens: new CounterTokenSource(),
    });
    const client = scriptedPeer<LockResponse, LockRequest>();
    coordinator.serve(client.connection);
    const deadline = delay(1000, 'still held' as const, { ref: false });

    // Act
    client.deliver({ op: 'acquire', id: 'a', key: 'product:42' });
    client.deliver({ op: 'acquire', id: 'a', key: 'product:42' });
    await waitUntil(
      t,
      () => client.sent.length > 0,
      'The first acquire must be granted',
    );
    client.deliver({ op: 'release', id: 'a' });
    await delay(settle);

    // Assert: one grant, and the key is free again after that one release.
    assert.equal(
      client.sent.filter((response) => response.op === 'granted').length,
      1,
      'The same request id must be granted only once',
    );
    const next = await Promise.race([
      coordinator.acquire('product:42').then(() => 'granted' as const),
      deadline,
    ]);
    assert.equal(
      next,
      'granted',
      'Releasing the request must free the key for the next caller',
    );
  });
});

type ScriptedPeer = ReturnType<typeof scriptedPeer<LockResponse, LockRequest>>;

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

describe('Grace window after a failover', () => {
  test('an acquire that arrives during the grace window is granted only after it ends', async (t) => {
    // Arrange
    const { connect } = coordinatorAfterFailover(200);
    const waiter = connect();

    // Act
    waiter.deliver({ op: 'acquire', id: 'w', key: 'product:42' });
    await delay(100);
    const duringGrace = [...waiter.sent];

    // Assert
    assert.deepEqual(
      duringGrace,
      [],
      'Nothing may be granted during the grace window',
    );
    await waitUntil(
      t,
      () => waiter.sent.some((response) => response.op === 'granted'),
      'The acquire must be granted once the grace window ends',
    );
  });

  test('a reasserted key stays with its holder, ahead of an acquire that arrived first', async () => {
    // Arrange: a waiter's acquire arrives before the holder reconnects.
    const { coordinator, connect } = coordinatorAfterFailover(100);
    const waiter = connect();
    const holder = connect();
    waiter.deliver({ op: 'acquire', id: 'w', key: 'product:42' });
    holder.deliver({ op: 'reassert', id: 'h', key: 'product:42', token: '5' });

    // Act: the grace window ends while the holder still has the key.
    await delay(200);
    const afterGrace = [...waiter.sent];
    holder.deliver({ op: 'release', id: 'h' });

    // Assert: the waiter gets the key only after the holder releases it.
    assert.deepEqual(
      afterGrace,
      [],
      'The waiter was granted a key that a holder reasserted',
    );
    assert.equal(
      await grantedWithin(coordinator.acquire('other-key'), settle),
      'granted',
      'Other keys must not wait',
    );
    await delay(settle);
    assert.equal(
      waiter.sent[0]?.op,
      'granted',
      'The waiter must get the key after the release',
    );
  });

  test('when two holders reassert one key, the newer token keeps it', async (t) => {
    // Arrange
    const { coordinator, connect } = coordinatorAfterFailover(150);
    const older = connect();
    const newer = connect();

    // Act
    older.deliver({ op: 'reassert', id: 'o', key: 'product:42', token: '5' });
    newer.deliver({ op: 'reassert', id: 'n', key: 'product:42', token: '9' });
    await waitUntil(
      t,
      () => older.sent.length > 0,
      'The older claim must be answered',
    );
    older.drop();
    await delay(200);

    // Assert: the older claim is refused, and its disconnect does not free the newer holder's key.
    assert.deepEqual(older.sent, [{ op: 'rejected', id: 'o' }]);
    assert.deepEqual(newer.sent, [], 'The newer claim must not be refused');
    const next = coordinator.acquire('product:42');
    assert.equal(
      await grantedWithin(next, settle),
      'waiting',
      'The newer holder must still have the key',
    );
    newer.deliver({ op: 'release', id: 'n' });
    assert.equal(
      await grantedWithin(next, 1000),
      'granted',
      'The key must be free after the newer holder releases it',
    );
  });

  test('waiters that arrive during the grace window are granted in arrival order', async (t) => {
    // Arrange: two peers wait for one key during the grace window.
    const { connect } = coordinatorAfterFailover(100);
    const first = connect();
    const second = connect();
    first.deliver({ op: 'acquire', id: 'f', key: 'product:42' });
    second.deliver({ op: 'acquire', id: 's', key: 'product:42' });
    await waitUntil(
      t,
      () => first.sent.length > 0,
      'The first waiter must be granted when the grace window ends',
    );
    await delay(settle);
    const secondBeforeRelease = [...second.sent];

    // Act
    first.deliver({ op: 'release', id: 'f' });

    // Assert
    assert.equal(first.sent[0]?.op, 'granted');
    assert.deepEqual(
      secondBeforeRelease,
      [],
      'The second waiter must wait for the first',
    );
    await waitUntil(
      t,
      () => second.sent.some((response) => response.op === 'granted'),
      'The second waiter must be granted after the first releases',
    );
  });

  test('a try after the grace window can be granted', async (t) => {
    // Arrange
    const { connect } = coordinatorAfterFailover(50);
    const peer = connect();
    await delay(100);

    // Act
    peer.deliver({ op: 'try', id: 't', key: 'product:42' });

    // Assert
    await waitUntil(
      t,
      () => peer.sent.length > 0,
      'The coordinator must answer the try',
    );
    assert.equal(peer.sent[0]?.op, 'granted');
  });
});

describe('A peer that disconnects from its coordinator', () => {
  test('a peer that disconnects while it waits does not keep the key', async () => {
    // Arrange: the key is held, and a peer waits for it.
    const coordinator = new LockCoordinator({
      tokens: new CounterTokenSource(),
    });
    const holder = await coordinator.acquire('product:42');
    const quitter = scriptedPeer<LockResponse, LockRequest>();
    coordinator.serve(quitter.connection);
    quitter.deliver({ op: 'acquire', id: 'q', key: 'product:42' });

    // Act: the peer disconnects, and then the holder releases.
    quitter.drop();
    await holder[Symbol.asyncDispose]();

    // Assert: the grant that reached the gone peer is given back.
    assert.equal(
      await grantedWithin(coordinator.acquire('product:42'), 1000),
      'granted',
      'A peer that left must not keep the key it waited for',
    );
    assert.deepEqual(quitter.sent, [], 'A peer that left must not be answered');
  });

  for (const [leaves, leave] of [
    ['disconnects', (peer: ScriptedPeer) => peer.drop()],
    [
      'releases',
      (peer: ScriptedPeer) => peer.deliver({ op: 'release', id: 'first' }),
    ],
  ] as const) {
    test(`a newer reassert after the first reasserter ${leaves} keeps the key from waiters`, async () => {
      // Arrange: the first reasserter takes the key in the grace window, then lets it go.
      const graceWindow = 300;
      const { coordinator, connect } = coordinatorAfterFailover(graceWindow);
      const first = connect();
      first.deliver({
        op: 'reassert',
        id: 'first',
        key: 'product:42',
        token: '5',
      });
      await delay(settle);
      leave(first);
      await delay(settle);

      // Act: a holder with a newer token reasserts the key.
      const newer = connect();
      newer.deliver({
        op: 'reassert',
        id: 'newer',
        key: 'product:42',
        token: '9',
      });
      const waiter = coordinator.acquire('product:42');

      // Assert: only one holder at a time, so the waiter gets the key after the newer holder releases it.
      assert.deepEqual(newer.sent, [], 'The newer claim must not be refused');
      assert.deepEqual(
        first.sent,
        [],
        'A holder that already let the key go must not be told it lost it',
      );
      assert.equal(
        await grantedWithin(waiter, graceWindow + 2 * settle),
        'waiting',
        'A waiter was granted a key that a newer reasserter holds',
      );
      newer.deliver({ op: 'release', id: 'newer' });
      assert.equal(
        await grantedWithin(waiter, 1000),
        'granted',
        'The key must be free after the newer holder releases it',
      );
    });
  }

  test('after a reasserter releases in the grace window, a reassert with an older token is still refused', async (t) => {
    // Arrange: a holder reasserts a newer token and then releases the key.
    const { connect } = coordinatorAfterFailover(300);
    const newer = connect();
    newer.deliver({
      op: 'reassert',
      id: 'newer',
      key: 'product:42',
      token: '9',
    });
    await delay(settle);
    newer.deliver({ op: 'release', id: 'newer' });
    await delay(settle);

    // Act: a stale holder from an older term reasserts the same key.
    const stale = connect();
    stale.deliver({
      op: 'reassert',
      id: 'stale',
      key: 'product:42',
      token: '5',
    });
    await waitUntil(
      t,
      () => stale.sent.length > 0,
      'The stale claim must be answered',
    );

    // Assert: the highest token seen still decides, so the stale holder cannot take the key.
    assert.deepEqual(stale.sent, [{ op: 'rejected', id: 'stale' }]);
  });

  test('a reassert repeated on one connection keeps the key with its holder', async () => {
    // Arrange
    const graceWindow = 150;
    const { coordinator, connect } = coordinatorAfterFailover(graceWindow);
    const holder = connect();
    const reassert = {
      op: 'reassert',
      id: 'h',
      key: 'product:42',
      token: '5',
    } as const;

    // Act: the same reassert arrives twice in one turn, before the first is registered.
    holder.deliver(reassert);
    holder.deliver(reassert);
    const waiter = coordinator.acquire('product:42');

    // Assert: the holder keeps the key until it releases it.
    assert.equal(
      await grantedWithin(waiter, graceWindow + 2 * settle),
      'waiting',
      'A repeated reassert must not free a key its holder still has',
    );
    holder.deliver({ op: 'release', id: 'h' });
    assert.equal(
      await grantedWithin(waiter, 1000),
      'granted',
      'The key must be free after the holder releases it',
    );
  });

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

  test('a release that arrives while its reassert is being registered frees the key', async () => {
    // Arrange
    const graceWindow = 100;
    const { coordinator, connect } = coordinatorAfterFailover(graceWindow);
    const holder = connect();

    // Act: the holder reasserts and releases in the same turn, before the claim is registered.
    holder.deliver({
      op: 'reassert',
      id: 'h',
      key: 'product:42',
      token: '5',
    });
    holder.deliver({ op: 'release', id: 'h' });

    // Assert: the key is free once the grace window ends, although the holder is still connected.
    assert.equal(
      await grantedWithin(coordinator.acquire('product:42'), graceWindow + 500),
      'granted',
      'A released key must not stay held until its connection closes',
    );
  });

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

describe('Giving up over the protocol', () => {
  test('a try during the grace window is answered busy', async (t) => {
    // Arrange
    const { connect } = coordinatorAfterFailover(200);
    const client = connect();

    // Act
    client.deliver({ op: 'try', id: 't', key: 'product:42' });

    // Assert: nothing is granted during the grace window, so the key counts as busy.
    await waitUntil(
      t,
      () => client.sent.length > 0,
      'The coordinator must answer the try',
    );
    assert.deepEqual(client.sent, [{ op: 'busy', id: 't' }]);
  });

  // Kept until a raw socket peer replaces it: the real client gives back a late grant, which hides a coordinator that ignores 'cancel'.
  test('a waiter that cancels does not keep the key from the callers after it', async (t) => {
    // Arrange: one peer holds the key, a second peer waits for it.
    const coordinator = new LockCoordinator({
      tokens: new CounterTokenSource(),
    });
    const holder = scriptedPeer<LockResponse, LockRequest>();
    const quitter = scriptedPeer<LockResponse, LockRequest>();
    coordinator.serve(holder.connection);
    coordinator.serve(quitter.connection);
    holder.deliver({ op: 'acquire', id: 'h', key: 'product:42' });
    await waitUntil(
      t,
      () => holder.sent.length > 0,
      'The holder must be granted',
    );
    quitter.deliver({ op: 'acquire', id: 'q', key: 'product:42' });

    // Act: the waiter cancels, then the holder releases.
    quitter.deliver({ op: 'cancel', id: 'q' });
    holder.deliver({ op: 'release', id: 'h' });

    // Assert: the next caller gets the key, and the waiter that cancelled was never granted.
    assert.equal(
      await grantedWithin(coordinator.acquire('product:42'), 1000),
      'granted',
    );
    assert.deepEqual(
      quitter.sent,
      [],
      'A cancelled request must not be granted',
    );
  });
});

describe('Remote lock client connection lifecycle', () => {
  // Kept as a double: a real connection reports its drop later, never inside send(); socket-store-reconnect.test.ts covers a drop after the send.
  test('an acquire whose connection drops while it is sent is sent again once on the next connection', async (t) => {
    // Arrange: the first connection drops during the send of the acquire.
    const { connector, calls } = scriptedConnector<LockRequest, LockResponse>();
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

describe('Holder check over the protocol', () => {
  test('a coordinator answers a request it does not know as unsupported, and its peer keeps its key', async (t) => {
    // Arrange: a peer of a newer version holds a key.
    const coordinator = new LockCoordinator({
      tokens: new CounterTokenSource(),
    });
    const peer = scriptedPeer<LockResponse, LockRequest | RequestEnvelope>();
    coordinator.serve(peer.connection);
    peer.deliver({ op: 'acquire', id: 'a', key: 'product:42' });
    await waitUntil(
      t,
      () => peer.sent.some((response) => response.op === 'granted'),
      'The peer must be granted the key',
    );

    // Act: 'renew' stands in for a request that a later version adds.
    peer.deliver({ op: 'renew', id: 'r' });
    await waitUntil(
      t,
      () => peer.sent.length === 2,
      'The coordinator must answer the request',
    );
    const stillHeld = await coordinator.isHeld('product:42');

    // Assert
    assert.deepEqual(peer.sent[1], { op: 'unsupported', id: 'r' });
    assert.equal(peer.closes, 0, 'The connection must stay open');
    assert.equal(stillHeld, true, 'The peer must keep its key');
  });

  test('a look during the grace window waits for it to end, then sees the key that was reasserted', async (t) => {
    // Arrange: a holder from before the failover reasserts its key.
    const { connect } = coordinatorAfterFailover(200);
    const holder = connect();
    const looker = connect();
    holder.deliver({
      op: 'reassert',
      id: 'h',
      key: 'product:42',
      token: '7',
    });

    // Act
    looker.deliver({ op: 'isHeld', id: 'held', key: 'product:42' });
    looker.deliver({ op: 'isHeld', id: 'free', key: 'product:7' });
    await delay(100);
    const duringGrace = [...looker.sent];
    await waitUntil(
      t,
      () => looker.sent.length === 2,
      'The looks must be answered once the grace window ends',
    );

    // Assert
    assert.deepEqual(
      duringGrace,
      [],
      'Holders may still reassert, so no look is answered yet',
    );
    assert.deepEqual(
      [...looker.sent].sort((a, b) => a.id.localeCompare(b.id)),
      [
        { op: 'held', id: 'free', held: false },
        { op: 'held', id: 'held', held: true },
      ],
    );
  });
});
