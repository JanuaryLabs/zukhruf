import assert from 'node:assert/strict';
import { hash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { connect } from 'node:net';
import { resolve } from 'node:path';
import { type TestContext, describe } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';

import { type Clock, untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { waitFor } from '@zukhruf/testing/async';
import { test } from '@zukhruf/testing/node';

import { isRecord } from '../../shared/is-record.ts';
import { grantedWithin } from '../../testing/granted-within.ts';
import { linesOf } from '../../testing/lines-of.ts';
import { settle } from '../../testing/timing.ts';
import { PROTOCOL_VERSION } from './handshake.ts';
import { SocketStore } from './index.ts';
import { SessionDirectory } from './session-directory.ts';
import { socketElection } from './socket-election.ts';

/**
 * Where a store meets its leader: `lock.sock` in the directory, or on Windows
 * the pipe named for that socket path
 * (wire-compatibility.test.ts pins both).
 */
function publishedSocketPath(directory: string) {
  const socketPath = resolve(directory, 'lock.sock');
  if (process.platform !== 'win32') return socketPath;
  const id = hash('sha256', socketPath.toLowerCase()).slice(0, 32);
  return `\\\\.\\pipe\\zukhruf-mutex-${id}`;
}

/** Makes `store` the leader of `directory` with its first call, and owns both. */
async function serving<Extra extends object>(
  stack: AsyncDisposableStack,
  directory: string,
  store: SocketStore,
  extra: Extra,
) {
  // During a recovery the leader answers its own try busy at once.
  const warmUp = await store.tryAcquire('warm-up');
  await warmUp?.[Symbol.asyncDispose]();
  const owned = stack.move();
  return {
    ...extra,
    directory,
    leader: store,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

/** A real store that leads the first term of its directory, which has no recovery. */
async function firstLeader() {
  await using stack = new AsyncDisposableStack();
  const directory = stack.use(
    await new TemporaryFiles().directory('mutex-test-'),
  );
  const store = stack.use(
    new SocketStore(directory.path, { clock: globalThis }),
  );
  return await serving(stack, directory.path, store, {});
}

/**
 * A real store that leads the term after an earlier one that did not shut
 * down cleanly, as after a failover. Each of `sessions` is recorded first, as
 * a process records its session before it connects, with a lease duration of
 * one minute, so the leader grants nothing until each of them sent its
 * end-of-reasserts marker. `clock` is the clock of the leader; `records`
 * gives the record of each session, which a test can dispose as a process
 * that stops frees its presence.
 */
async function leaderAfterFailover(
  sessions: string[],
  clock: Clock = globalThis,
) {
  await using stack = new AsyncDisposableStack();
  const directory = stack.use(
    await new TemporaryFiles().directory('mutex-test-'),
  );
  const earlier = await socketElection(directory.path, globalThis).campaign();
  await earlier?.resign();
  const directoryOfSessions = new SessionDirectory(directory.path, globalThis);
  const records = new Map<string, AsyncDisposable>();
  for (const session of sessions) {
    records.set(
      session,
      stack.use(await directoryOfSessions.record(session, 60_000)),
    );
  }
  const store = stack.use(new SocketStore(directory.path, { clock }));
  return await serving(stack, directory.path, store, { records });
}

/** The end-of-reasserts marker of a session. */
const reasserted = { op: 'reasserted' };

/**
 * A process that talks to the leader on its socket, line by line, the way a
 * follower does. `send` writes all its lines in one write, so the leader reads
 * them in one turn.
 */
async function rawPeer(
  t: TestContext,
  directory: string,
  session: string = randomUUID(),
) {
  const socket = connect(publishedSocketPath(directory));
  socket.on('error', () => {});
  await once(socket, 'connect');
  const received: Record<string, unknown>[] = [];
  const reader = linesOf(socket).on('line', (line) => {
    const message: unknown = JSON.parse(line);
    received.push(isRecord(message) ? message : { line });
  });
  const answered = once(reader, 'line');
  socket.write(
    `${JSON.stringify({ op: 'hello', version: PROTOCOL_VERSION, session })}\n`,
  );
  // The leader must answer the hello.
  await untilAborted(answered, t.signal);
  assert.equal(received.shift()?.op, 'welcome');
  const lines = (requests: unknown[]) =>
    requests.map((request) => `${JSON.stringify(request)}\n`).join('');
  return {
    /** Every answer after the welcome, in order. */
    received,
    send: (...requests: unknown[]) => {
      socket.write(lines(requests));
    },
    /** Sends `requests` and hangs up, so the leader reads them before the close. */
    leave: (...requests: unknown[]) => {
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

describe('A leader after a failover', () => {
  test('an acquire that arrives during the recovery is granted only after it ends', async (t) => {
    // Arrange
    await using scene = await leaderAfterFailover(['waiter', 'other']);
    await using waiter = await rawPeer(t, scene.directory, 'waiter');
    await using other = await rawPeer(t, scene.directory, 'other');

    // Act
    waiter.send(reasserted, { op: 'acquire', id: 'w', key: 'product:42' });
    await delay(settle);
    const duringRecovery = [...waiter.received];
    other.send(reasserted);

    // Assert
    assert.deepEqual(
      duringRecovery,
      [],
      'Nothing may be granted while a recorded session may still reassert',
    );
    await waitFor(
      () =>
        assert.ok(
          waiter.received.some((response) => response.op === 'granted'),
          'The acquire must be granted once the recovery ends',
        ),
      { signal: t.signal },
    );
  });

  test('a reassert that arrives after the recovery is refused', async (t) => {
    // Arrange: a holder reconnects after its recovery ended, for example after a second connection of its process sent the marker.
    await using scene = await leaderAfterFailover(['holder']);
    await using holder = await rawPeer(t, scene.directory, 'holder');
    holder.send(reasserted);
    // The look of the leader is answered once the recovery is over.
    await scene.leader.isHeld('product:42');

    // Act
    holder.send({ op: 'reassert', id: 'h', key: 'product:42', token: '7' });

    // Assert
    await waitFor(
      () =>
        assert.ok(
          holder.received.length > 0,
          'The leader must answer the reassert',
        ),
      { signal: t.signal },
    );
    assert.deepEqual(holder.received, [{ op: 'rejected', id: 'h' }]);
  });

  test('a reasserted key stays with its holder, ahead of an acquire that arrived first, and other keys do not wait', async (t) => {
    // Arrange: a waiter's acquire arrives before the holder reconnects.
    await using scene = await leaderAfterFailover(['waiter', 'holder']);
    await using waiter = await rawPeer(t, scene.directory, 'waiter');
    await using holder = await rawPeer(t, scene.directory, 'holder');
    waiter.send(reasserted, { op: 'acquire', id: 'w', key: 'product:42' });
    await delay(settle);
    holder.send(
      { op: 'reassert', id: 'h', key: 'product:42', token: '5' },
      reasserted,
    );

    // Act: the recovery ends while the holder still has the key.
    const held = await scene.leader.isHeld('product:42');
    await delay(settle);
    const afterRecovery = [...waiter.received];
    const otherKey = await grantedWithin(
      scene.leader.acquire('other-key'),
      settle,
    );
    holder.send({ op: 'release', id: 'h' });

    // Assert: the waiter gets the key only after the holder releases it.
    assert.equal(held, true, 'The reasserted key must be held');
    assert.deepEqual(
      afterRecovery,
      [],
      'The waiter was granted a key that a holder reasserted',
    );
    assert.equal(otherKey, 'granted', 'Other keys must not wait');
    await waitFor(
      () =>
        assert.ok(
          waiter.received[0]?.op === 'granted',
          'The waiter must get the key after the release',
        ),
      { signal: t.signal },
    );
  });

  test('when two holders reassert one key, the newer token keeps it, and the older one leaving does not free it', async (t) => {
    // Arrange
    await using scene = await leaderAfterFailover(['older', 'newer']);
    await using older = await rawPeer(t, scene.directory, 'older');
    await using newer = await rawPeer(t, scene.directory, 'newer');

    // Act
    older.send(
      { op: 'reassert', id: 'o', key: 'product:42', token: '5' },
      reasserted,
    );
    await delay(settle);
    newer.send(
      { op: 'reassert', id: 'n', key: 'product:42', token: '9' },
      reasserted,
    );
    await waitFor(
      () =>
        assert.ok(
          older.received.length > 0,
          'The older claim must be answered',
        ),
      { signal: t.signal },
    );
    const olderAnswers = [...older.received];
    older.drop();
    await delay(settle);

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
    // The key must be free after the newer holder releases it
    await untilAborted(next, t.signal);
  });

  test('a recovering session whose connection closes before its marker, and whose process still runs, keeps the recovery open', async (t) => {
    // Arrange: the presence of the session stays held, as a process that reconnects keeps it.
    await using scene = await leaderAfterFailover(['holder']);
    await using holder = await rawPeer(t, scene.directory, 'holder');
    holder.send({ op: 'reassert', id: 'h', key: 'product:42', token: '5' });
    await delay(settle);

    // Act
    holder.drop();
    const waiter = scene.leader.acquire('other-key');

    // Assert
    assert.equal(
      await grantedWithin(waiter, 2 * settle),
      'waiting',
      'A closed connection of a session that runs must not end its recovery',
    );
    await using again = await rawPeer(t, scene.directory, 'holder');
    again.send(reasserted);
    // The marker of the reconnected session must end the recovery
    await untilAborted(waiter, t.signal);
  });

  test('a recovering session whose connection closes before its marker, and whose presence is free, ends its recovery at once', async (t) => {
    // Arrange: the clock of the leader never moves, so no step of the back-off checks the presence.
    await using scene = await leaderAfterFailover(['holder'], createClock());
    await using holder = await rawPeer(t, scene.directory, 'holder');
    holder.send({ op: 'reassert', id: 'h', key: 'product:42', token: '5' });
    await delay(settle);
    const waiter = scene.leader.acquire('product:42', { signal: t.signal });

    // Act: the process of the session stops: its presence frees, and its connection closes.
    await scene.records.get('holder')?.[Symbol.asyncDispose]();
    holder.drop();

    // Assert
    // The close of the connection must end the recovery of a session that stopped
    await untilAborted(waiter, t.signal);
  });

  test('waiters that arrive during the recovery are granted in arrival order', async (t) => {
    // Arrange: two peers wait for one key during the recovery.
    await using scene = await leaderAfterFailover(['first', 'second']);
    await using first = await rawPeer(t, scene.directory, 'first');
    await using second = await rawPeer(t, scene.directory, 'second');
    first.send({ op: 'acquire', id: 'f', key: 'product:42' });
    await delay(settle);
    second.send({ op: 'acquire', id: 's', key: 'product:42' });
    await delay(settle);
    first.send(reasserted);
    second.send(reasserted);
    await waitFor(
      () =>
        assert.ok(
          first.received.length > 0,
          'The first waiter must be granted when the recovery ends',
        ),
      { signal: t.signal },
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
    await waitFor(
      () =>
        assert.ok(
          second.received.some((response) => response.op === 'granted'),
          'The second waiter must be granted after the first releases',
        ),
      { signal: t.signal },
    );
  });

  test('a try during the recovery is answered busy', async (t) => {
    // Arrange
    await using scene = await leaderAfterFailover(['peer']);
    await using peer = await rawPeer(t, scene.directory, 'peer');

    // Act
    peer.send({ op: 'try', id: 't', key: 'product:42' });

    // Assert: nothing is granted during the recovery, so the key counts as busy.
    await waitFor(
      () =>
        assert.ok(peer.received.length > 0, 'The leader must answer the try'),
      { signal: t.signal },
    );
    assert.deepEqual(peer.received, [{ op: 'busy', id: 't' }]);
  });

  test('a try after the recovery can be granted', async (t) => {
    // Arrange
    await using scene = await leaderAfterFailover(['peer']);
    await using peer = await rawPeer(t, scene.directory, 'peer');

    // Act: the marker ends the recovery, and the try comes after it on the same connection.
    peer.send(reasserted, { op: 'try', id: 't', key: 'product:42' });

    // Assert
    await waitFor(
      () =>
        assert.ok(peer.received.length > 0, 'The leader must answer the try'),
      { signal: t.signal },
    );
    assert.equal(peer.received[0]?.op, 'granted');
  });

  void test.each(
    [
      ['disconnects', (peer: RawPeer) => peer.drop()],
      [
        'releases',
        (peer: RawPeer) => peer.send({ op: 'release', id: 'first' }),
      ],
    ] as const,
    ([leaves, leave]) =>
      test(`a newer reassert after the first reasserter ${leaves} keeps the key from waiters`, async (t) => {
        // Arrange: the first reasserter takes the key in the recovery, then lets it go.
        await using scene = await leaderAfterFailover(['first', 'newer']);
        await using first = await rawPeer(t, scene.directory, 'first');
        await using newer = await rawPeer(t, scene.directory, 'newer');
        first.send(
          {
            op: 'reassert',
            id: 'first',
            key: 'product:42',
            token: '5',
          },
          reasserted,
        );
        await delay(settle);
        leave(first);
        await delay(settle);

        // Act: a holder with a newer token reasserts the key, and the recovery ends.
        newer.send(
          {
            op: 'reassert',
            id: 'newer',
            key: 'product:42',
            token: '9',
          },
          reasserted,
        );
        const waiter = scene.leader.acquire('product:42');

        // Assert: only one holder at a time, so the waiter gets the key after the newer holder releases it.
        assert.equal(
          await grantedWithin(waiter, 2 * settle),
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
        // The key must be free after the newer holder releases it
        await untilAborted(waiter, t.signal);
      }),
  );

  test('after a reasserter releases in the recovery, a reassert with an older token is still refused', async (t) => {
    // Arrange: a holder reasserts a newer token and then releases the key.
    await using scene = await leaderAfterFailover(['newer', 'stale']);
    await using newer = await rawPeer(t, scene.directory, 'newer');
    await using stale = await rawPeer(t, scene.directory, 'stale');
    newer.send({ op: 'reassert', id: 'newer', key: 'product:42', token: '9' });
    await delay(settle);
    newer.send({ op: 'release', id: 'newer' });
    await delay(settle);

    // Act: a stale holder from an older term reasserts the same key.
    stale.send({ op: 'reassert', id: 'stale', key: 'product:42', token: '5' });
    await waitFor(
      () =>
        assert.ok(
          stale.received.length > 0,
          'The stale claim must be answered',
        ),
      { signal: t.signal },
    );

    // Assert: the highest token seen still decides, so the stale holder cannot take the key.
    assert.deepEqual(stale.received, [{ op: 'rejected', id: 'stale' }]);
  });
});

type RawPeer = Awaited<ReturnType<typeof rawPeer>>;

describe('Requests that a leader reads in one turn', () => {
  test('a reassert repeated on one connection keeps the key with its holder', async (t) => {
    // Arrange
    await using scene = await leaderAfterFailover(['holder']);
    await using holder = await rawPeer(t, scene.directory, 'holder');
    const reassert = { op: 'reassert', id: 'h', key: 'product:42', token: '5' };

    // Act: the same reassert arrives twice in one write, before the first is registered.
    holder.send(reassert, reassert, reasserted);
    const waiter = scene.leader.acquire('product:42');

    // Assert: the holder keeps the key until it releases it.
    assert.equal(
      await grantedWithin(waiter, 2 * settle),
      'waiting',
      'A repeated reassert must not free a key its holder still has',
    );
    holder.send({ op: 'release', id: 'h' });
    // The key must be free after the holder releases it
    await untilAborted(waiter, t.signal);
  });

  test('of two claims for one key in one write, the newer outranks the older before it is registered', async (t) => {
    // Arrange
    await using scene = await leaderAfterFailover(['peer']);
    await using peer = await rawPeer(t, scene.directory, 'peer');

    // Act: two claims arrive in one write, so the older one is outranked before it is registered.
    peer.send(
      { op: 'reassert', id: 'o', key: 'product:42', token: '5' },
      { op: 'reassert', id: 'n', key: 'product:42', token: '9' },
      reasserted,
    );
    const waiter = scene.leader.acquire('product:42');

    // Assert: the key passes to the newer claim and then to the waiter, and the older claim is refused.
    assert.equal(
      await grantedWithin(waiter, 2 * settle),
      'waiting',
      'The newer claim must have the key after the recovery',
    );
    peer.send({ op: 'release', id: 'n' });
    // An outranked claim must not keep the key after the newer claim releases it
    await untilAborted(waiter, t.signal);
    assert.deepEqual(peer.received, [{ op: 'rejected', id: 'o' }]);
  });

  test('a release that arrives while its reassert is being registered frees the key', async (t) => {
    // Arrange
    await using scene = await leaderAfterFailover(['holder']);
    await using holder = await rawPeer(t, scene.directory, 'holder');

    // Act: the holder reasserts and releases in one write, before the claim is registered.
    holder.send(
      { op: 'reassert', id: 'h', key: 'product:42', token: '5' },
      { op: 'release', id: 'h' },
      reasserted,
    );

    // Assert: the key is free once the recovery ends, although the holder is still connected.
    // A released key must not stay held until its connection closes
    await untilAborted(scene.leader.acquire('product:42'), t.signal);
    assert.equal(holder.closed, false);
  });

  test('a peer that hangs up right after it reasserts does not keep the key', async (t) => {
    // Arrange
    await using scene = await leaderAfterFailover(['holder']);
    await using holder = await rawPeer(t, scene.directory, 'holder');

    // Act: the peer reasserts and hangs up in one step. Its claim resolves before the leader reads the close, so the leader releases it when the connection ends.
    holder.leave(
      { op: 'reassert', id: 'h', key: 'product:42', token: '5' },
      reasserted,
    );

    // Assert: once the recovery ends, the key is free.
    // A peer that left must not keep the key it reasserted
    await untilAborted(scene.leader.acquire('product:42'), t.signal);
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
    await waitFor(
      () =>
        assert.ok(
          peer.received.length > 0,
          'The first acquire must be granted',
        ),
      { signal: t.signal },
    );
    peer.send({ op: 'release', id: 'a' });
    await delay(settle);

    // Assert: one grant, and the key is free again after that one release.
    assert.equal(
      peer.received.filter((response) => response.op === 'granted').length,
      1,
      'The same request id must be granted only once',
    );
    // Releasing the request must free the key for the next caller
    await untilAborted(scene.leader.acquire('product:42'), t.signal);
  });

  test('a resent try is granted once, and its release frees the key', async (t) => {
    // Arrange: a follower's try reaches the leader twice, as after a reconnect.
    await using scene = await firstLeader();
    await using peer = await rawPeer(t, scene.directory);

    // Act
    peer.send(
      { op: 'try', id: 't', key: 'product:42' },
      { op: 'try', id: 't', key: 'product:42' },
    );
    await waitFor(
      () =>
        assert.ok(peer.received.length > 0, 'The first try must be granted'),
      { signal: t.signal },
    );
    peer.send({ op: 'release', id: 't' });
    await delay(settle);

    // Assert: one grant and no busy answer for the copy, and the key is free again after that one release.
    assert.deepEqual(
      peer.received.map((response) => response.op),
      ['granted'],
      'The same request id must be answered only once, with its grant',
    );
    // Releasing the request must free the key for the next caller
    await untilAborted(scene.leader.acquire('product:42'), t.signal);
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

    // Act: the peer disconnects, the leader ends its session, and then the holder releases.
    quitter.drop();
    await delay(settle);
    await holder[Symbol.asyncDispose]();

    // Assert: the key does not go to the peer that left.
    // A peer that left must not keep the key it waited for
    await untilAborted(scene.leader.acquire('product:42'), t.signal);
  });

  test('a waiter that cancels does not keep the key from the callers after it, even if it never releases a late grant', async (t) => {
    // Arrange: one peer holds the key, and a second peer waits for it and
    // then cancels. Unlike a store, this peer never gives back a grant that
    // reaches it after its cancel, so only the leader's cancel frees the key.
    await using scene = await firstLeader();
    await using holder = await rawPeer(t, scene.directory);
    await using quitter = await rawPeer(t, scene.directory);
    holder.send({ op: 'acquire', id: 'h', key: 'product:42' });
    await waitFor(
      () => assert.ok(holder.received.length > 0, 'The holder must be granted'),
      { signal: t.signal },
    );
    quitter.send(
      { op: 'acquire', id: 'q', key: 'product:42' },
      { op: 'cancel', id: 'q' },
    );
    await delay(settle);

    // Act
    holder.send({ op: 'release', id: 'h' });

    // Assert: the next caller gets the key, and the waiter that cancelled was never granted.
    await untilAborted(scene.leader.acquire('product:42'), t.signal);
    assert.deepEqual(
      quitter.received,
      [],
      'A cancelled request must not be granted',
    );
  });
});

describe('Requests a leader does not know, and looks', () => {
  test('a peer that sends a JSON line that is not a request keeps its key', async (t) => {
    // Arrange: a peer holds a key.
    await using scene = await firstLeader();
    await using peer = await rawPeer(t, scene.directory);
    peer.send({ op: 'acquire', id: 'a', key: 'product:42' });
    await waitFor(
      () =>
        assert.ok(
          peer.received.some((response) => response.op === 'granted'),
          'The peer must be granted the key',
        ),
      { signal: t.signal },
    );

    // Act: JSON lines that are not requests (no record, no id, no op, neither, an op it does not know), then a look.
    peer.send(
      null,
      { op: 'acquire', key: 'product:7' },
      { id: 'x' },
      { note: 'not a lock request' },
      { op: 'renew', id: 'r' },
      { op: 'isHeld', id: 'look', key: 'product:42' },
    );
    await waitFor(
      () =>
        assert.ok(
          peer.received.some((response) => response.id === 'look'),
          'The leader must answer the look after the lines it cannot read',
        ),
      { signal: t.signal },
    );
    // Asked after the look was answered, so an answer to any earlier line is in by now.
    peer.send({ op: 'isHeld', id: 'after', key: 'product:7' });
    await waitFor(
      () =>
        assert.ok(
          peer.received.some((response) => response.id === 'after'),
          'The leader must answer the second look',
        ),
      { signal: t.signal },
    );
    const stillHeld = await scene.leader.isHeld('product:42');

    // Assert: no line got an answer or a grant, and the connection kept the key.
    assert.deepEqual(peer.received.slice(1), [
      { op: 'held', id: 'look', held: true },
      { op: 'held', id: 'after', held: false },
    ]);
    assert.equal(peer.closed, false, 'The connection must stay open');
    assert.equal(stillHeld, true, 'The peer must keep its key');
  });

  test('a look during the recovery waits for it to end, then sees the key that was reasserted', async (t) => {
    // Arrange: a holder from before the failover reasserts its key.
    await using scene = await leaderAfterFailover(['holder', 'looker']);
    await using holder = await rawPeer(t, scene.directory, 'holder');
    await using looker = await rawPeer(t, scene.directory, 'looker');
    holder.send(
      { op: 'reassert', id: 'h', key: 'product:42', token: '7' },
      reasserted,
    );

    // Act
    looker.send(
      { op: 'isHeld', id: 'held', key: 'product:42' },
      { op: 'isHeld', id: 'free', key: 'product:7' },
    );
    await delay(settle);
    const duringRecovery = [...looker.received];
    looker.send(reasserted);
    await waitFor(
      () =>
        assert.ok(
          looker.received.length === 2,
          'The looks must be answered once the recovery ends',
        ),
      { signal: t.signal },
    );

    // Assert
    assert.deepEqual(
      duringRecovery,
      [],
      'Holders may still reassert, so no look is answered yet',
    );
    assert.deepEqual(
      looker.received.toSorted((a, b) =>
        String(a.id).localeCompare(String(b.id)),
      ),
      [
        { op: 'held', id: 'free', held: false },
        { op: 'held', id: 'held', held: true },
      ],
    );
  });
});
