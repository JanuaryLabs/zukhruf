import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { connect } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { type TestContext, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { SocketStore } from '../../index.ts';
import { LeaderElection } from '../../leader-election/leader-election.ts';
import { isRecord } from '../../shared/is-record.ts';
import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { settle } from '../../testing/store-cases.ts';
import { waitUntil } from '../../testing/wait-until.ts';

/**
 * Where every published version of a store meets its leader: `lock.sock` in
 * the directory, or on Windows the pipe named for the directory
 * (wire-compatibility.test.ts pins both).
 */
function publishedSocketPath(directory: string) {
  if (process.platform !== 'win32') return join(directory, 'lock.sock');
  const id = createHash('sha256')
    .update(resolve(directory).toLowerCase())
    .digest('hex')
    .slice(0, 32);
  return `\\\\.\\pipe\\mutex-${id}`;
}

/** Makes `store` the leader of `directory` with its first call, and owns both. */
async function serving(
  stack: AsyncDisposableStack,
  directory: string,
  store: SocketStore,
) {
  // During a grace window the leader answers its own try busy at once.
  const warmUp = await store.tryAcquire('warm-up');
  await warmUp?.[Symbol.asyncDispose]();
  const owned = stack.move();
  return {
    directory,
    leader: store,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

/** A real store that leads the first term of its directory, which has no grace window. */
async function firstLeader() {
  await using stack = new AsyncDisposableStack();
  const directory = stack.use(await scratchDirectory());
  const store = stack.use(
    new SocketStore(directory.path, { pollInterval: 10 }),
  );
  return await serving(stack, directory.path, store);
}

/**
 * A real store that leads the term after an earlier one, as after a failover,
 * so it grants nothing for `graceWindow` milliseconds from its first call.
 */
async function leaderAfterFailover(graceWindow: number) {
  await using stack = new AsyncDisposableStack();
  const directory = stack.use(await scratchDirectory());
  const earlier = await new LeaderElection(directory.path, {
    pollInterval: 10,
  }).campaign();
  await earlier?.resign();
  const store = stack.use(
    new SocketStore(directory.path, { pollInterval: 10, graceWindow }),
  );
  return await serving(stack, directory.path, store);
}

/**
 * A process that talks to the leader on its socket, line by line, the way a
 * follower does. `send` writes all its lines in one write, so the leader reads
 * them in one turn.
 */
async function rawPeer(t: TestContext, directory: string) {
  const socket = connect(publishedSocketPath(directory));
  socket.on('error', () => {});
  await once(socket, 'connect');
  const received: Record<string, unknown>[] = [];
  createInterface({ input: socket }).on('line', (line) => {
    const message: unknown = JSON.parse(line);
    received.push(isRecord(message) ? message : { line });
  });
  socket.write(`${JSON.stringify({ op: 'hello', version: 1 })}\n`);
  await waitUntil(
    t,
    () => received.length > 0,
    'The leader must answer the hello',
  );
  assert.equal(received.shift()?.op, 'welcome');
  const lines = (requests: Record<string, unknown>[]) =>
    requests.map((request) => `${JSON.stringify(request)}\n`).join('');
  return {
    /** Every answer after the welcome, in order. */
    received,
    send: (...requests: Record<string, unknown>[]) => {
      socket.write(lines(requests));
    },
    /** Sends `requests` and hangs up, so the leader reads them before the close. */
    leave: (...requests: Record<string, unknown>[]) => {
      socket.end(lines(requests));
    },
    drop: () => socket.destroy(),
    get closed() {
      return socket.closed;
    },
    [Symbol.asyncDispose]: async () => {
      socket.destroy();
    },
  };
}

/** Resolves `'granted'` if `lease` arrives within `milliseconds`, otherwise `'waiting'`. */
function grantedWithin(lease: Promise<unknown>, milliseconds: number) {
  return Promise.race([
    lease.then(() => 'granted' as const),
    delay(milliseconds, 'waiting' as const, { ref: false }),
  ]);
}

describe('A leader after a failover', () => {
  test('an acquire that arrives during the grace window is granted only after it ends', async (t) => {
    // Arrange
    await using scene = await leaderAfterFailover(600);
    await using waiter = await rawPeer(t, scene.directory);

    // Act
    waiter.send({ op: 'acquire', id: 'w', key: 'product:42' });
    await delay(150);
    const duringGrace = [...waiter.received];

    // Assert
    assert.deepEqual(
      duringGrace,
      [],
      'Nothing may be granted during the grace window',
    );
    await waitUntil(
      t,
      () => waiter.received.some((response) => response.op === 'granted'),
      'The acquire must be granted once the grace window ends',
    );
  });

  test('a reassert that arrives after the grace window is refused', async (t) => {
    // Arrange: a holder reconnects too late, for example after a freeze.
    await using scene = await leaderAfterFailover(50);
    await using holder = await rawPeer(t, scene.directory);
    await delay(100);

    // Act
    holder.send({ op: 'reassert', id: 'h', key: 'product:42', token: '7' });

    // Assert
    await waitUntil(
      t,
      () => holder.received.length > 0,
      'The leader must answer the reassert',
    );
    assert.deepEqual(holder.received, [{ op: 'rejected', id: 'h' }]);
  });

  test('a reasserted key stays with its holder, ahead of an acquire that arrived first, and other keys do not wait', async (t) => {
    // Arrange: a waiter's acquire arrives before the holder reconnects.
    await using scene = await leaderAfterFailover(200);
    await using waiter = await rawPeer(t, scene.directory);
    await using holder = await rawPeer(t, scene.directory);
    waiter.send({ op: 'acquire', id: 'w', key: 'product:42' });
    await delay(settle);
    holder.send({ op: 'reassert', id: 'h', key: 'product:42', token: '5' });

    // Act: the grace window ends while the holder still has the key.
    await delay(300);
    const afterGrace = [...waiter.received];
    const otherKey = await grantedWithin(
      scene.leader.acquire('other-key'),
      settle,
    );
    holder.send({ op: 'release', id: 'h' });

    // Assert: the waiter gets the key only after the holder releases it.
    assert.deepEqual(
      afterGrace,
      [],
      'The waiter was granted a key that a holder reasserted',
    );
    assert.equal(otherKey, 'granted', 'Other keys must not wait');
    await waitUntil(
      t,
      () => waiter.received[0]?.op === 'granted',
      'The waiter must get the key after the release',
    );
  });

  test('when two holders reassert one key, the newer token keeps it, and the older one leaving does not free it', async (t) => {
    // Arrange
    await using scene = await leaderAfterFailover(150);
    await using older = await rawPeer(t, scene.directory);
    await using newer = await rawPeer(t, scene.directory);

    // Act
    older.send({ op: 'reassert', id: 'o', key: 'product:42', token: '5' });
    await delay(settle);
    newer.send({ op: 'reassert', id: 'n', key: 'product:42', token: '9' });
    await waitUntil(
      t,
      () => older.received.length > 0,
      'The older claim must be answered',
    );
    const olderAnswers = [...older.received];
    older.drop();
    await delay(250);

    // Assert: the older claim is refused, and its disconnect does not free the newer holder's key.
    assert.deepEqual(olderAnswers, [{ op: 'rejected', id: 'o' }]);
    assert.deepEqual(newer.received, [], 'The newer claim must not be refused');
    const next = scene.leader.acquire('product:42');
    assert.equal(
      await grantedWithin(next, settle),
      'waiting',
      'The newer holder must still have the key',
    );
    newer.send({ op: 'release', id: 'n' });
    assert.equal(
      await grantedWithin(next, 1000),
      'granted',
      'The key must be free after the newer holder releases it',
    );
  });

  test('waiters that arrive during the grace window are granted in arrival order', async (t) => {
    // Arrange: two peers wait for one key during the grace window.
    await using scene = await leaderAfterFailover(200);
    await using first = await rawPeer(t, scene.directory);
    await using second = await rawPeer(t, scene.directory);
    first.send({ op: 'acquire', id: 'f', key: 'product:42' });
    await delay(settle);
    second.send({ op: 'acquire', id: 's', key: 'product:42' });
    await waitUntil(
      t,
      () => first.received.length > 0,
      'The first waiter must be granted when the grace window ends',
    );
    await delay(settle);
    const secondBeforeRelease = [...second.received];

    // Act
    first.send({ op: 'release', id: 'f' });

    // Assert
    assert.equal(first.received[0]?.op, 'granted');
    assert.deepEqual(
      secondBeforeRelease,
      [],
      'The second waiter must wait for the first',
    );
    await waitUntil(
      t,
      () => second.received.some((response) => response.op === 'granted'),
      'The second waiter must be granted after the first releases',
    );
  });

  test('a try during the grace window is answered busy', async (t) => {
    // Arrange
    await using scene = await leaderAfterFailover(300);
    await using peer = await rawPeer(t, scene.directory);

    // Act
    peer.send({ op: 'try', id: 't', key: 'product:42' });

    // Assert: nothing is granted during the grace window, so the key counts as busy.
    await waitUntil(
      t,
      () => peer.received.length > 0,
      'The leader must answer the try',
    );
    assert.deepEqual(peer.received, [{ op: 'busy', id: 't' }]);
  });

  test('a try after the grace window can be granted', async (t) => {
    // Arrange
    await using scene = await leaderAfterFailover(50);
    await using peer = await rawPeer(t, scene.directory);
    await delay(100);

    // Act
    peer.send({ op: 'try', id: 't', key: 'product:42' });

    // Assert
    await waitUntil(
      t,
      () => peer.received.length > 0,
      'The leader must answer the try',
    );
    assert.equal(peer.received[0]?.op, 'granted');
  });

  for (const [leaves, leave] of [
    ['disconnects', (peer: RawPeer) => peer.drop()],
    ['releases', (peer: RawPeer) => peer.send({ op: 'release', id: 'first' })],
  ] as const) {
    test(`a newer reassert after the first reasserter ${leaves} keeps the key from waiters`, async (t) => {
      // Arrange: the first reasserter takes the key in the grace window, then lets it go.
      const graceWindow = 300;
      await using scene = await leaderAfterFailover(graceWindow);
      await using first = await rawPeer(t, scene.directory);
      await using newer = await rawPeer(t, scene.directory);
      first.send({
        op: 'reassert',
        id: 'first',
        key: 'product:42',
        token: '5',
      });
      await delay(settle);
      leave(first);
      await delay(settle);

      // Act: a holder with a newer token reasserts the key.
      newer.send({
        op: 'reassert',
        id: 'newer',
        key: 'product:42',
        token: '9',
      });
      const waiter = scene.leader.acquire('product:42');

      // Assert: only one holder at a time, so the waiter gets the key after the newer holder releases it.
      assert.equal(
        await grantedWithin(waiter, graceWindow + 2 * settle),
        'waiting',
        'A waiter was granted a key that a newer reasserter holds',
      );
      assert.deepEqual(
        newer.received,
        [],
        'The newer claim must not be refused',
      );
      assert.deepEqual(
        first.received,
        [],
        'A holder that already let the key go must not be told it lost it',
      );
      newer.send({ op: 'release', id: 'newer' });
      assert.equal(
        await grantedWithin(waiter, 1000),
        'granted',
        'The key must be free after the newer holder releases it',
      );
    });
  }

  test('after a reasserter releases in the grace window, a reassert with an older token is still refused', async (t) => {
    // Arrange: a holder reasserts a newer token and then releases the key.
    await using scene = await leaderAfterFailover(300);
    await using newer = await rawPeer(t, scene.directory);
    await using stale = await rawPeer(t, scene.directory);
    newer.send({ op: 'reassert', id: 'newer', key: 'product:42', token: '9' });
    await delay(settle);
    newer.send({ op: 'release', id: 'newer' });
    await delay(settle);

    // Act: a stale holder from an older term reasserts the same key.
    stale.send({ op: 'reassert', id: 'stale', key: 'product:42', token: '5' });
    await waitUntil(
      t,
      () => stale.received.length > 0,
      'The stale claim must be answered',
    );

    // Assert: the highest token seen still decides, so the stale holder cannot take the key.
    assert.deepEqual(stale.received, [{ op: 'rejected', id: 'stale' }]);
  });
});

type RawPeer = Awaited<ReturnType<typeof rawPeer>>;

describe('Requests that a leader reads in one turn', () => {
  test('a reassert repeated on one connection keeps the key with its holder', async (t) => {
    // Arrange
    const graceWindow = 150;
    await using scene = await leaderAfterFailover(graceWindow);
    await using holder = await rawPeer(t, scene.directory);
    const reassert = { op: 'reassert', id: 'h', key: 'product:42', token: '5' };

    // Act: the same reassert arrives twice in one write, before the first is registered.
    holder.send(reassert, reassert);
    const waiter = scene.leader.acquire('product:42');

    // Assert: the holder keeps the key until it releases it.
    assert.equal(
      await grantedWithin(waiter, graceWindow + 2 * settle),
      'waiting',
      'A repeated reassert must not free a key its holder still has',
    );
    holder.send({ op: 'release', id: 'h' });
    assert.equal(
      await grantedWithin(waiter, 1000),
      'granted',
      'The key must be free after the holder releases it',
    );
  });

  test('of two claims for one key in one write, the newer outranks the older before it is registered', async (t) => {
    // Arrange
    const graceWindow = 150;
    await using scene = await leaderAfterFailover(graceWindow);
    await using peer = await rawPeer(t, scene.directory);

    // Act: two claims arrive in one write, so the older one is outranked before it is registered.
    peer.send(
      { op: 'reassert', id: 'o', key: 'product:42', token: '5' },
      { op: 'reassert', id: 'n', key: 'product:42', token: '9' },
    );
    const waiter = scene.leader.acquire('product:42');

    // Assert: the key passes to the newer claim and then to the waiter, and the older claim is refused.
    assert.equal(
      await grantedWithin(waiter, graceWindow + 2 * settle),
      'waiting',
      'The newer claim must have the key after the grace window',
    );
    peer.send({ op: 'release', id: 'n' });
    assert.equal(
      await grantedWithin(waiter, 1000),
      'granted',
      'An outranked claim must not keep the key after the newer claim releases it',
    );
    assert.deepEqual(peer.received, [{ op: 'rejected', id: 'o' }]);
  });

  test('a release that arrives while its reassert is being registered frees the key', async (t) => {
    // Arrange
    const graceWindow = 100;
    await using scene = await leaderAfterFailover(graceWindow);
    await using holder = await rawPeer(t, scene.directory);

    // Act: the holder reasserts and releases in one write, before the claim is registered.
    holder.send(
      { op: 'reassert', id: 'h', key: 'product:42', token: '5' },
      { op: 'release', id: 'h' },
    );

    // Assert: the key is free once the grace window ends, although the holder is still connected.
    assert.equal(
      await grantedWithin(
        scene.leader.acquire('product:42'),
        graceWindow + 500,
      ),
      'granted',
      'A released key must not stay held until its connection closes',
    );
    assert.equal(holder.closed, false);
  });

  test('a peer that hangs up right after it reasserts does not keep the key', async (t) => {
    // Arrange
    await using scene = await leaderAfterFailover(100);
    await using holder = await rawPeer(t, scene.directory);

    // Act: the peer reasserts and hangs up in one step. Its claim resolves before the leader reads the close, so the leader releases it when the connection ends.
    holder.leave({ op: 'reassert', id: 'h', key: 'product:42', token: '5' });

    // Assert: once the grace window ends, the key is free.
    assert.equal(
      await grantedWithin(scene.leader.acquire('product:42'), 1000),
      'granted',
      'A peer that left must not keep the key it reasserted',
    );
  });

  test('a resent acquire is granted once, and its release frees the key', async (t) => {
    // Arrange: a follower's acquire reaches the leader twice, as after a reconnect.
    await using scene = await firstLeader();
    await using peer = await rawPeer(t, scene.directory);

    // Act
    peer.send(
      { op: 'acquire', id: 'a', key: 'product:42' },
      { op: 'acquire', id: 'a', key: 'product:42' },
    );
    await waitUntil(
      t,
      () => peer.received.length > 0,
      'The first acquire must be granted',
    );
    peer.send({ op: 'release', id: 'a' });
    await delay(settle);

    // Assert: one grant, and the key is free again after that one release.
    assert.equal(
      peer.received.filter((response) => response.op === 'granted').length,
      1,
      'The same request id must be granted only once',
    );
    assert.equal(
      await grantedWithin(scene.leader.acquire('product:42'), 1000),
      'granted',
      'Releasing the request must free the key for the next caller',
    );
  });
});

describe('A peer that gives up or leaves', () => {
  test('a peer that disconnects while it waits does not keep the key', async (t) => {
    // Arrange: the key is held, and a peer waits for it.
    await using scene = await firstLeader();
    const holder = await scene.leader.acquire('product:42');
    await using quitter = await rawPeer(t, scene.directory);
    quitter.send({ op: 'acquire', id: 'q', key: 'product:42' });
    await delay(settle);

    // Act: the peer disconnects, and then the holder releases.
    quitter.drop();
    await holder[Symbol.asyncDispose]();

    // Assert: the key does not go to the peer that left.
    assert.equal(
      await grantedWithin(scene.leader.acquire('product:42'), 1000),
      'granted',
      'A peer that left must not keep the key it waited for',
    );
  });

  test('a waiter that cancels does not keep the key from the callers after it, even if it never releases a late grant', async (t) => {
    // Arrange: one peer holds the key, and a second peer waits for it and
    // then cancels. Unlike a store, this peer never gives back a grant that
    // reaches it after its cancel, so only the leader's cancel frees the key.
    await using scene = await firstLeader();
    await using holder = await rawPeer(t, scene.directory);
    await using quitter = await rawPeer(t, scene.directory);
    holder.send({ op: 'acquire', id: 'h', key: 'product:42' });
    await waitUntil(
      t,
      () => holder.received.length > 0,
      'The holder must be granted',
    );
    quitter.send(
      { op: 'acquire', id: 'q', key: 'product:42' },
      { op: 'cancel', id: 'q' },
    );
    await delay(settle);

    // Act
    holder.send({ op: 'release', id: 'h' });

    // Assert: the next caller gets the key, and the waiter that cancelled was never granted.
    assert.equal(
      await grantedWithin(scene.leader.acquire('product:42'), 1000),
      'granted',
    );
    assert.deepEqual(
      quitter.received,
      [],
      'A cancelled request must not be granted',
    );
  });
});

describe('Requests a leader does not know, and looks', () => {
  test('a leader answers a request it does not know as unsupported, and its peer keeps its key', async (t) => {
    // Arrange: a peer of a newer version holds a key.
    await using scene = await firstLeader();
    await using peer = await rawPeer(t, scene.directory);
    peer.send({ op: 'acquire', id: 'a', key: 'product:42' });
    await waitUntil(
      t,
      () => peer.received.some((response) => response.op === 'granted'),
      'The peer must be granted the key',
    );

    // Act: 'renew' stands in for a request that a later version adds.
    peer.send({ op: 'renew', id: 'r' });
    await waitUntil(
      t,
      () => peer.received.length === 2,
      'The leader must answer the request',
    );
    const stillHeld = await scene.leader.isHeld('product:42');

    // Assert
    assert.deepEqual(peer.received[1], { op: 'unsupported', id: 'r' });
    assert.equal(peer.closed, false, 'The connection must stay open');
    assert.equal(stillHeld, true, 'The peer must keep its key');
  });

  test('a look during the grace window waits for it to end, then sees the key that was reasserted', async (t) => {
    // Arrange: a holder from before the failover reasserts its key.
    await using scene = await leaderAfterFailover(600);
    await using holder = await rawPeer(t, scene.directory);
    await using looker = await rawPeer(t, scene.directory);
    holder.send({ op: 'reassert', id: 'h', key: 'product:42', token: '7' });

    // Act
    looker.send(
      { op: 'isHeld', id: 'held', key: 'product:42' },
      { op: 'isHeld', id: 'free', key: 'product:7' },
    );
    await delay(150);
    const duringGrace = [...looker.received];
    await waitUntil(
      t,
      () => looker.received.length === 2,
      'The looks must be answered once the grace window ends',
    );

    // Assert
    assert.deepEqual(
      duringGrace,
      [],
      'Holders may still reassert, so no look is answered yet',
    );
    assert.deepEqual(
      [...looker.received].sort((a, b) =>
        String(a.id).localeCompare(String(b.id)),
      ),
      [
        { op: 'held', id: 'free', held: false },
        { op: 'held', id: 'held', held: true },
      ],
    );
  });
});
