import assert from 'node:assert/strict';
import { type TestContext, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { CounterTokenSource } from '../../fencing/counter-token-source.ts';
import type { Lease } from '../../mutex/lease.ts';
import { LockLostError } from '../../mutex/lock-lost-error.ts';
import { Mutex } from '../../mutex/mutex.ts';
import {
  scriptedConnector,
  scriptedPeer,
} from '../../testing/scripted-peer.ts';
import { settle } from '../../testing/store-cases.ts';
import { waitUntil } from '../../testing/wait-until.ts';
import { watch } from '../../testing/watch.ts';
import { ConnectionSupervisor } from './connection-supervisor.ts';
import type { ClientConnector } from './connector.ts';
import { CoordinatorUnavailableError } from './coordinator-unavailable-error.ts';
import { LockCoordinator } from './lock-coordinator.ts';
import type { LockRequest, LockResponse, RequestEnvelope } from './protocol.ts';
import { RemoteLockClient } from './remote-lock-client.ts';
import { UnsupportedRequestError } from './unsupported-request-error.ts';

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

/** Opens the client's first connection with a warm-up try, and gives back whatever it was granted. */
async function openFirstConnection(
  t: TestContext,
  client: RemoteLockClient,
  calls: ReturnType<
    typeof scriptedConnector<LockRequest, LockResponse>
  >['calls'],
  peer: ReturnType<typeof scriptedPeer<LockRequest, LockResponse>>,
) {
  const warmUp = client.tryAcquire('warm-up');
  await waitUntil(t, () => calls.length === 1, 'The client must connect');
  calls[0]!.resolve(peer.connection);
  await waitUntil(
    t,
    () => peer.sent.length > 0,
    'The warm-up try must be sent',
  );
  peer.deliver({ op: 'busy', id: peer.sent[0]!.id });
  const lease = await warmUp;
  await lease?.[Symbol.asyncDispose]();
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

  test('a lease released while its connection drops is not reasserted on the next connection', async (t) => {
    // Arrange: the first connection grants the key, then drops while the release is in flight.
    const releaseStalls = Promise.withResolvers<void>();
    const first = scriptedPeer<LockRequest, LockResponse>(async (request) => {
      if (request.op === 'acquire') {
        queueMicrotask(() =>
          first.deliver({ op: 'granted', id: request.id, token: '1' }),
        );
      }
      if (request.op === 'release') {
        first.drop();
        await releaseStalls.promise;
      }
    });
    const second = scriptedPeer<LockRequest, LockResponse>();
    const connections = [first.connection, second.connection];
    const client = clientOver({ connect: async () => connections.shift() });
    const lease = await client.acquire('product:42');

    try {
      // Act: release, and let the client reconnect while that release is still being sent.
      void lease[Symbol.asyncDispose]();
      await waitUntil(
        t,
        () => connections.length === 0,
        'The client must reconnect',
      );
      await delay(settle);

      // Assert: the released lease is not brought back on the new connection.
      assert.deepEqual(
        second.sent.filter((request) => request.op === 'reassert'),
        [],
        'A lease being released must never be reasserted after a reconnect',
      );
    } finally {
      releaseStalls.resolve();
      await client.close();
    }
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

  test('a reassert that arrives after the grace window is refused', async (t) => {
    // Arrange: a holder reconnects too late, for example after a freeze.
    const { connect } = coordinatorAfterFailover(50);
    const holder = connect();
    await delay(100);

    // Act
    holder.deliver({ op: 'reassert', id: 'h', key: 'product:42', token: '7' });

    // Assert
    await waitUntil(
      t,
      () => holder.sent.length > 0,
      'The coordinator must answer the reassert',
    );
    assert.deepEqual(holder.sent, [{ op: 'rejected', id: 'h' }]);
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

  test('a peer that disconnects releases the keys it holds', async (t) => {
    // Arrange
    const coordinator = new LockCoordinator({
      tokens: new CounterTokenSource(),
    });
    const peer = scriptedPeer<LockResponse, LockRequest>();
    coordinator.serve(peer.connection);
    peer.deliver({ op: 'acquire', id: 'a', key: 'product:42' });
    await waitUntil(t, () => peer.sent.length > 0, 'The peer must be granted');

    // Act
    peer.drop();

    // Assert
    assert.equal(
      await grantedWithin(coordinator.acquire('product:42'), 1000),
      'granted',
      'A peer that left must not keep the keys it held',
    );
  });
});

describe('Giving up over the protocol', () => {
  test('a grant that arrives after the caller gave up is released', async (t) => {
    // Arrange: a client waits for a key through a scripted coordinator.
    const coordinator = scriptedPeer<LockRequest, LockResponse>();
    const client = clientOver({ connect: async () => coordinator.connection });
    const giveUp = new AbortController();
    const attempt = client.acquire('product:42', { signal: giveUp.signal });
    await waitUntil(
      t,
      () => coordinator.sent.length > 0,
      'The client must send its acquire',
    );
    const id = coordinator.sent[0]!.id;

    try {
      // Act: the caller gives up, and the grant was already on its way.
      giveUp.abort();
      await assert.rejects(attempt);
      coordinator.deliver({ op: 'granted', id, token: '1' });
      await delay(settle);

      // Assert: the client cancels its request and gives the late grant back.
      assert.deepEqual(coordinator.sent.slice(1), [
        { op: 'cancel', id },
        { op: 'release', id },
      ]);
    } finally {
      await client.close();
    }
  });

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
  test('closing the client as its connection opens rejects the acquire, and the connection carries nothing', async (t) => {
    // Arrange: an acquire waits for the first connection.
    const { connector, calls } = scriptedConnector<LockRequest, LockResponse>();
    const client = clientOver(connector);
    const peer = grantingPeer();
    const acquiring = watch(client.acquire('product:42'));
    await waitUntil(t, () => calls.length === 1, 'The client must connect');

    // Act: the connection opens just as the client closes.
    calls[0]!.resolve(peer.connection);
    await client.close();
    await delay(settle);

    // Assert
    assert.equal(
      acquiring.now.status,
      'rejected',
      'A closed client must not grant',
    );
    assert.deepEqual(
      peer.sent,
      [],
      'Nothing may be sent on a connection that opens after close',
    );
    assert.equal(peer.closes, 1, 'That connection must be closed');
  });

  test('closing the client rejects an acquire that still waits', async (t) => {
    // Arrange: an acquire reached a coordinator that does not answer it.
    const { connector, calls } = scriptedConnector<LockRequest, LockResponse>();
    const client = clientOver(connector);
    const peer = scriptedPeer<LockRequest, LockResponse>();
    const acquiring = watch(client.acquire('product:42'));
    await waitUntil(t, () => calls.length === 1, 'The client must connect');
    calls[0]!.resolve(peer.connection);
    await waitUntil(
      t,
      () => peer.sent.length === 1,
      'The acquire must reach the coordinator',
    );

    // Act
    await client.close();

    // Assert
    await waitUntil(
      t,
      () => acquiring.now.status === 'rejected',
      'A waiting acquire must be rejected when its client closes',
    );
  });

  test('a try made while the client reconnects is asked of the new coordinator once', async (t) => {
    // Arrange: the first connection dropped, and the next one is on its way.
    const { connector, calls } = scriptedConnector<LockRequest, LockResponse>();
    const client = clientOver(connector);
    const first = scriptedPeer<LockRequest, LockResponse>();
    const second = grantingPeer();
    await openFirstConnection(t, client, calls, first);
    first.drop();
    await waitUntil(t, () => calls.length === 2, 'The client must reconnect');

    try {
      // Act
      const trying = client.tryAcquire('product:42');
      calls[1]!.resolve(second.connection);
      const lease = await trying;
      await delay(settle);

      // Assert: no coordinator said busy, so the new one decides.
      assert.ok(
        lease,
        'A free key must be granted to a try made during a reconnect',
      );
      assert.deepEqual(
        second.sent.map((request) => request.op),
        ['try'],
        'The try must be sent once, and its grant kept',
      );
    } finally {
      await client.close();
    }
  });

  test('an acquire made while the client reconnects is sent once on the new connection', async (t) => {
    // Arrange: the first connection dropped, and the next one is on its way.
    const { connector, calls } = scriptedConnector<LockRequest, LockResponse>();
    const client = clientOver(connector);
    const first = scriptedPeer<LockRequest, LockResponse>();
    const second = scriptedPeer<LockRequest, LockResponse>();
    await openFirstConnection(t, client, calls, first);
    first.drop();
    await waitUntil(t, () => calls.length === 2, 'The client must reconnect');

    try {
      // Act
      watch(client.acquire('product:42'));
      calls[1]!.resolve(second.connection);
      await delay(settle);

      // Assert
      assert.deepEqual(
        second.sent.map((request) => request.op),
        ['acquire'],
        'The acquire must be sent exactly once',
      );
    } finally {
      await client.close();
    }
  });

  test('an acquire given up before the connection opens never reaches the coordinator', async (t) => {
    // Arrange: an acquire waits for the first connection.
    const { connector, calls } = scriptedConnector<LockRequest, LockResponse>();
    const client = clientOver(connector);
    const peer = grantingPeer();
    const giveUp = new AbortController();
    const acquiring = client.acquire('product:42', { signal: giveUp.signal });
    await waitUntil(t, () => calls.length === 1, 'The client must connect');

    try {
      // Act: the caller gives up, then the connection opens.
      giveUp.abort();
      await assert.rejects(acquiring, { name: 'AbortError' });
      calls[0]!.resolve(peer.connection);
      await delay(settle);

      // Assert
      assert.deepEqual(
        peer.sent,
        [],
        'A request given up before it was sent must never be sent',
      );
    } finally {
      await client.close();
    }
  });

  test('a connector that fails rejects the waiting acquire with its error, and the next acquire connects again', async (t) => {
    // Arrange
    const { connector, calls } = scriptedConnector<LockRequest, LockResponse>();
    const client = clientOver(connector);
    const failure = new Error('EACCES: the lock directory is not writable');
    const acquiring = client.acquire('product:42');
    await waitUntil(t, () => calls.length === 1, 'The client must connect');

    try {
      // Act
      calls[0]!.reject(failure);
      await assert.rejects(acquiring, (error) => error === failure);
      watch(client.acquire('product:42'));

      // Assert
      await waitUntil(
        t,
        () => calls.length === 2,
        'The next acquire must ask the connector again',
      );
    } finally {
      await client.close();
    }
  });

  test('a holder whose reconnect fails learns that its lease was lost', async (t) => {
    // Arrange: the client holds a key on its first connection.
    const { connector, calls } = scriptedConnector<LockRequest, LockResponse>();
    const client = clientOver(connector);
    const first = grantingPeer();
    const unhandled: unknown[] = [];
    const collect = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', collect);

    try {
      const acquiring = client.acquire('product:42');
      await waitUntil(t, () => calls.length === 1, 'The client must connect');
      calls[0]!.resolve(first.connection);
      const lease = await acquiring;

      // Act: the connection drops, and connecting again fails.
      first.drop();
      await waitUntil(t, () => calls.length === 2, 'The client must reconnect');
      calls[1]!.reject(new Error('EACCES: the lock directory is not writable'));
      await delay(settle);

      // Assert: no coordinator heard the reassert, so another holder may have
      // the key; releasing it then has nothing left to release.
      assert.ok(
        lease.signal.reason instanceof LockLostError,
        `The lease must say the key is lost, not ${String(lease.signal.reason)}`,
      );
      assert.equal(lease.signal.reason.key, 'product:42');
      await assert.doesNotReject(async () => lease[Symbol.asyncDispose]());
      assert.deepEqual(
        unhandled,
        [],
        'A failed reconnect must not become an unhandled rejection',
      );
    } finally {
      process.off('unhandledRejection', collect);
      await client.close();
    }
  });

  test('a task whose key is lost while it runs is told before it ends', async (t) => {
    // Arrange: a task holds a key through the Mutex, on the client's first connection.
    const { connector, calls } = scriptedConnector<LockRequest, LockResponse>();
    const client = clientOver(connector);
    const first = grantingPeer();
    const timeline: string[] = [];
    const holding = Promise.withResolvers<Lease>();
    const finish = Promise.withResolvers<void>();
    const running = new Mutex(client)
      .acquire('product:42', async (lease) => {
        lease.signal.addEventListener('abort', () =>
          timeline.push(
            lease.signal.reason instanceof LockLostError
              ? `the task is told ${lease.signal.reason.key} is lost`
              : `unexpected reason: ${String(lease.signal.reason)}`,
          ),
        );
        holding.resolve(lease);
        await finish.promise;
        timeline.push('the task ends');
      })
      .catch((error: unknown) => {
        timeline.push(
          error instanceof LockLostError
            ? 'LockLostError after the task'
            : `unexpected: ${String(error)}`,
        );
      });

    try {
      await waitUntil(t, () => calls.length === 1, 'The client must connect');
      calls[0]!.resolve(first.connection);
      const lease = await holding.promise;

      // Act: while the task runs, the connection drops and connecting again fails.
      first.drop();
      await waitUntil(t, () => calls.length === 2, 'The client must reconnect');
      calls[1]!.reject(new Error('EACCES: the lock directory is not writable'));
      await waitUntil(t, () => lease.signal.aborted, 'The key must be lost');
      finish.resolve();
      await running;

      // Assert: the task heard of the loss while it could still stop writing,
      // and finishing normally does not hide that the key was not exclusive.
      assert.deepEqual(timeline, [
        'the task is told product:42 is lost',
        'the task ends',
        'LockLostError after the task',
      ]);
    } finally {
      finish.resolve();
      await client.close();
    }
  });

  test('a task whose reassert the new coordinator refuses is told before it ends, and releases nothing', async (t) => {
    // Arrange: a task holds a key through the Mutex, and the next coordinator refuses every reassert.
    const { connector, calls } = scriptedConnector<LockRequest, LockResponse>();
    const client = clientOver(connector);
    const first = grantingPeer();
    const second = scriptedPeer<LockRequest, LockResponse>(async (request) => {
      if (request.op === 'reassert') {
        queueMicrotask(() =>
          second.deliver({ op: 'rejected', id: request.id }),
        );
      }
    });
    const told = Promise.withResolvers<unknown>();
    const holding = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const running = watch(
      new Mutex(client).acquire('product:42', async (lease) => {
        lease.signal.addEventListener('abort', () =>
          told.resolve(lease.signal.reason),
        );
        holding.resolve();
        await finish.promise;
      }),
    );

    try {
      await waitUntil(t, () => calls.length === 1, 'The client must connect');
      calls[0]!.resolve(first.connection);
      await holding.promise;

      // Act: the connection drops, and the coordinator behind the next one refuses the reassert.
      first.drop();
      await waitUntil(t, () => calls.length === 2, 'The client must reconnect');
      calls[1]!.resolve(second.connection);
      const reason = await told.promise;
      finish.resolve();
      await waitUntil(
        t,
        () => running.now.status !== 'pending',
        'The call must end',
      );

      // Assert: the task was told while it ran, the call reports the loss,
      // and the coordinator that refused the key is not asked to release it.
      assert.ok(reason instanceof LockLostError, String(reason));
      assert.equal(reason.key, 'product:42');
      const ended = running.now;
      assert.ok(
        ended.status === 'rejected' && ended.reason === reason,
        `The call must reject with the lease's LockLostError, not ${JSON.stringify(ended)}`,
      );
      assert.deepEqual(
        second.sent.filter((request) => request.op === 'release'),
        [],
      );
    } finally {
      finish.resolve();
      await client.close();
    }
  });

  for (const [what, failure, expected] of [
    [
      'its own error',
      (_lease: Lease) => new Error('the write failed'),
      // A new LockLostError for the key, keeping the task's error as its cause.
      (error: LockLostError, thrown: unknown) =>
        error.key === 'product:42' && error.cause === thrown,
    ],
    [
      'the reason of its lease signal',
      (lease: Lease) => lease.signal.reason,
      // The lease's own LockLostError, not wrapped again.
      (error: LockLostError, thrown: unknown) =>
        error === thrown && error.cause === undefined,
    ],
  ] as const) {
    test(`a task that throws ${what} after its key is lost rejects its caller with LockLostError`, async (t) => {
      // Arrange: a task holds a key through the Mutex, on the client's first connection.
      const { connector, calls } = scriptedConnector<
        LockRequest,
        LockResponse
      >();
      const client = clientOver(connector);
      const first = grantingPeer();
      const holding = Promise.withResolvers<Lease>();
      const finish = Promise.withResolvers<void>();
      let thrown: unknown;
      const running = new Mutex(client).acquire('product:42', async (lease) => {
        holding.resolve(lease);
        await finish.promise;
        thrown = failure(lease);
        throw thrown;
      });

      try {
        await waitUntil(t, () => calls.length === 1, 'The client must connect');
        calls[0]!.resolve(first.connection);
        const lease = await holding.promise;

        // Act: the key is lost while the task runs, and then the task fails.
        first.drop();
        await waitUntil(
          t,
          () => calls.length === 2,
          'The client must reconnect',
        );
        calls[1]!.reject(
          new Error('EACCES: the lock directory is not writable'),
        );
        await waitUntil(t, () => lease.signal.aborted, 'The key must be lost');
        finish.resolve();

        // Assert: the caller learns the key was not exclusive, with the task's error kept.
        await assert.rejects(running, (error: unknown) => {
          assert.ok(error instanceof LockLostError, String(error));
          assert.ok(
            expected(error, thrown),
            `Unexpected LockLostError: cause ${String(error.cause)}`,
          );
          return true;
        });
      } finally {
        finish.resolve();
        await client.close();
      }
    });
  }

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

  test('a try in flight when no coordinator is left fails as unavailable', async (t) => {
    // Arrange: a try reached a coordinator that does not answer it.
    const { connector, calls } = scriptedConnector<LockRequest, LockResponse>();
    const client = clientOver(connector);
    const first = scriptedPeer<LockRequest, LockResponse>();
    const trying = client.tryAcquire('product:42');
    await waitUntil(t, () => calls.length === 1, 'The client must connect');
    calls[0]!.resolve(first.connection);
    await waitUntil(t, () => first.sent.length === 1, 'The try must be sent');

    try {
      // Act: the coordinator stops, and nothing can replace it.
      first.drop();
      await waitUntil(t, () => calls.length === 2, 'The client must reconnect');
      calls[1]!.resolve(undefined);

      // Assert
      await assert.rejects(trying, CoordinatorUnavailableError);
    } finally {
      await client.close();
    }
  });

  test('a try in flight when its coordinator is replaced is answered busy and not asked again', async (t) => {
    // Arrange: a try reached a coordinator that does not answer it.
    const { connector, calls } = scriptedConnector<LockRequest, LockResponse>();
    const client = clientOver(connector);
    const first = scriptedPeer<LockRequest, LockResponse>();
    const second = grantingPeer();
    const trying = client.tryAcquire('product:42');
    await waitUntil(t, () => calls.length === 1, 'The client must connect');
    calls[0]!.resolve(first.connection);
    await waitUntil(t, () => first.sent.length === 1, 'The try must be sent');

    try {
      // Act: the coordinator stops, and a new one takes over.
      first.drop();
      await waitUntil(t, () => calls.length === 2, 'The client must reconnect');
      calls[1]!.resolve(second.connection);

      // Assert: a try is one attempt, and its coordinator is gone.
      assert.equal(await trying, undefined);
      await delay(settle);
      assert.deepEqual(second.sent, [], 'The try must not be sent again');
    } finally {
      await client.close();
    }
  });

  test('a client that waits keeps its process alive through a reconnect', async (t) => {
    // Arrange: an acquire waits on the first connection.
    const { connector, calls } = scriptedConnector<LockRequest, LockResponse>();
    const client = clientOver(connector);
    const first = scriptedPeer<LockRequest, LockResponse>();
    const second = scriptedPeer<LockRequest, LockResponse>();
    watch(client.acquire('product:42'));
    await waitUntil(t, () => calls.length === 1, 'The client must connect');
    calls[0]!.resolve(first.connection);
    await waitUntil(
      t,
      () => first.sent.length === 1,
      'The acquire must be sent',
    );

    try {
      // Act
      first.drop();
      await waitUntil(t, () => calls.length === 2, 'The client must reconnect');
      calls[1]!.resolve(second.connection);
      await waitUntil(
        t,
        () => second.sent.length === 1,
        'The acquire must be sent again',
      );

      // Assert
      assert.equal(
        second.refs.at(-1),
        'ref',
        'A client that waits must keep its new connection referenced',
      );
    } finally {
      await client.close();
    }
  });

  test('a client that only holds keys lets its process exit through a reconnect', async (t) => {
    // Arrange: the client holds a key and waits for nothing.
    const { connector, calls } = scriptedConnector<LockRequest, LockResponse>();
    const client = clientOver(connector);
    const first = grantingPeer();
    const second = scriptedPeer<LockRequest, LockResponse>();
    const acquiring = client.acquire('product:42');
    await waitUntil(t, () => calls.length === 1, 'The client must connect');
    calls[0]!.resolve(first.connection);
    await acquiring;

    try {
      // Act
      first.drop();
      await waitUntil(t, () => calls.length === 2, 'The client must reconnect');
      calls[1]!.resolve(second.connection);
      await waitUntil(
        t,
        () => second.sent.some((request) => request.op === 'reassert'),
        'The held key must be reasserted',
      );

      // Assert
      assert.equal(
        second.refs.at(-1),
        'unref',
        'A client that waits for nothing must not keep its process alive',
      );
    } finally {
      await client.close();
    }
  });

  test('after a reconnect, held keys are reasserted before waiting acquires are sent again', async (t) => {
    // Arrange: the client holds one key and waits for another.
    const { connector, calls } = scriptedConnector<LockRequest, LockResponse>();
    const client = clientOver(connector);
    const first = scriptedPeer<LockRequest, LockResponse>(async (request) => {
      if (request.op === 'acquire' && request.key === 'held') {
        queueMicrotask(() =>
          first.deliver({ op: 'granted', id: request.id, token: '1' }),
        );
      }
    });
    const second = scriptedPeer<LockRequest, LockResponse>();
    const holding = client.acquire('held');
    await waitUntil(t, () => calls.length === 1, 'The client must connect');
    calls[0]!.resolve(first.connection);
    await holding;
    watch(client.acquire('waiting'));
    await waitUntil(
      t,
      () => first.sent.length === 2,
      'Both acquires must be sent',
    );

    try {
      // Act
      first.drop();
      await waitUntil(t, () => calls.length === 2, 'The client must reconnect');
      calls[1]!.resolve(second.connection);
      await delay(settle);

      // Assert
      assert.deepEqual(
        second.sent.map((request) => request.op),
        ['reassert', 'acquire'],
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

  test(
    'a look its coordinator does not know rejects with UnsupportedRequestError',
    { timeout: 5000 },
    async (t) => {
      // Arrange: a coordinator that answers every look as unsupported.
      const { connector, calls } = scriptedConnector<
        LockRequest,
        LockResponse
      >();
      const client = clientOver(connector);
      const peer = scriptedPeer<LockRequest, LockResponse>(async (request) => {
        if (request.op === 'isHeld') {
          queueMicrotask(() =>
            peer.deliver({ op: 'unsupported', id: request.id }),
          );
        }
      });

      // Act
      const look = client.isHeld('product:42');
      await waitUntil(t, () => calls.length === 1, 'The client must connect');
      calls[0]!.resolve(peer.connection);

      // Assert
      await assert.rejects(
        look,
        (error: unknown) =>
          error instanceof UnsupportedRequestError &&
          error.op === 'isHeld' &&
          error.key === 'product:42',
      );
    },
  );

  test('a look cut off by a lost connection is asked again of the next coordinator', async (t) => {
    // Arrange: the first coordinator is lost before it answers the look.
    const { connector, calls } = scriptedConnector<LockRequest, LockResponse>();
    const client = clientOver(connector);
    const first = scriptedPeer<LockRequest, LockResponse>();
    const look = client.isHeld('product:42');
    await waitUntil(t, () => calls.length === 1, 'The client must connect');
    calls[0]!.resolve(first.connection);
    await waitUntil(
      t,
      () => first.sent.some((request) => request.op === 'isHeld'),
      'The look must be sent',
    );

    // Act
    first.drop();
    await waitUntil(t, () => calls.length === 2, 'The client must reconnect');
    const second = scriptedPeer<LockRequest, LockResponse>(async (request) => {
      if (request.op === 'isHeld') {
        queueMicrotask(() =>
          second.deliver({ op: 'held', id: request.id, held: true }),
        );
      }
    });
    calls[1]!.resolve(second.connection);

    // Assert
    assert.equal(await look, true);
  });

  test(
    'a look with no coordinator left rejects with CoordinatorUnavailableError',
    { timeout: 5000 },
    async (t) => {
      // Arrange
      const { connector, calls } = scriptedConnector<
        LockRequest,
        LockResponse
      >();
      const client = clientOver(connector);

      // Act
      const look = client.isHeld('product:42');
      await waitUntil(t, () => calls.length === 1, 'The client must connect');
      calls[0]!.resolve(undefined);

      // Assert
      await assert.rejects(look, CoordinatorUnavailableError);
    },
  );
});
