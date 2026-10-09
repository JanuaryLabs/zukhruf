import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { type Socket, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { type TestContext, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import {
  type Lease,
  type LockHandle,
  LockLostError,
  Mutex,
  SocketStore,
  UnsupportedRequestError,
} from '../../index.ts';
import { LeaderElection } from '../../leader-election/leader-election.ts';
import { isRecord } from '../../shared/is-record.ts';
import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { settle } from '../../testing/store-cases.ts';
import { newProcessTimeout, waitUntil } from '../../testing/wait-until.ts';
import { watch } from '../../testing/watch.ts';
import { startWorker } from '../../testing/worker-process.ts';

const indexUrl = new URL('../../index.ts', import.meta.url);

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

/** One connection a store opened to the stand-in leader, as the leader sees it. */
interface LeaderSide {
  /** The first line the store sent, parsed. */
  hello: unknown;
  /** Every line after the hello, parsed, in order. */
  readonly requests: Record<string, unknown>[];
  closed: boolean;
  welcome(): void;
  refuse(): void;
  answer(response: Record<string, unknown>): void;
  drop(): void;
}

/**
 * A leader that the test plays by hand, on the socket a store connects to. It
 * keeps every connection and every line it reads, and answers only when the
 * test tells it to. The test holds the term, so the store follows it.
 */
async function standInLeader(directory: string) {
  const connections: LeaderSide[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    const write = (message: Record<string, unknown>) =>
      socket.write(`${JSON.stringify(message)}\n`);
    const side: LeaderSide = {
      hello: undefined,
      requests: [],
      closed: false,
      welcome: () => write({ op: 'welcome', ops: ['isHeld'] }),
      refuse: () =>
        socket.end(`${JSON.stringify({ op: 'refused', version: 99 })}\n`),
      answer: write,
      drop: () => socket.destroy(),
    };
    socket.once('close', () => (side.closed = true));
    connections.push(side);
    createInterface({ input: socket }).on('line', (line) => {
      const message: unknown = JSON.parse(line);
      if (side.hello === undefined) side.hello = message;
      else side.requests.push(isRecord(message) ? message : { line });
    });
  });
  server.listen(publishedSocketPath(directory));
  await once(server, 'listening');
  return {
    connections,
    [Symbol.asyncDispose]: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((done) => server.close(() => done()));
    },
  };
}

/**
 * A store that follows a stand-in leader: the test holds the term, so the
 * store never leads, and plays the leader on every connection the store opens.
 */
async function followerOfStandIn() {
  await using stack = new AsyncDisposableStack();
  const directory = stack.use(await scratchDirectory());
  stack.use(
    await new LeaderElection(directory.path, { pollInterval: 10 }).campaign(),
  );
  const leader = stack.use(await standInLeader(directory.path));
  const store = stack.use(
    new SocketStore(directory.path, { pollInterval: 10 }),
  );
  const owned = stack.move();
  return {
    leader,
    store,
    [Symbol.asyncDispose]: () => owned.disposeAsync(),
  };
}

type StandInLeader = Awaited<ReturnType<typeof standInLeader>>;

/** The `index`th connection the store opened, once its hello arrived. */
async function connection(
  t: TestContext,
  leader: StandInLeader,
  index: number,
  timeout = 2000,
) {
  await waitUntil(
    t,
    () => leader.connections[index]?.hello !== undefined,
    `The store must open connection ${index + 1} and say hello`,
    timeout,
  );
  return leader.connections[index]!;
}

/** The `index`th request on `side`, once it arrived. */
async function request(t: TestContext, side: LeaderSide, index: number) {
  await waitUntil(
    t,
    () => side.requests.length > index,
    () =>
      `The leader must read request ${index + 1}; it read ${JSON.stringify(side.requests)}`,
  );
  return side.requests[index]!;
}

/** Welcomes the first connection, grants the acquire on it, and gives back the lease. */
async function holding(
  t: TestContext,
  leader: StandInLeader,
  acquiring: Promise<LockHandle>,
) {
  const first = await connection(t, leader, 0);
  first.welcome();
  const { id } = await request(t, first, 0);
  first.answer({ op: 'granted', id, token: '1' });
  return acquiring;
}

describe('A socket store that loses its leader', () => {
  test('a holder whose reconnect is refused learns that its lease was lost', async (t) => {
    // Arrange: the store holds a key that its leader granted.
    await using follower = await followerOfStandIn();
    const { leader, store } = follower;
    const unhandled: unknown[] = [];
    const collect = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', collect);

    try {
      const lease = await holding(t, leader, store.acquire('product:42'));

      // Act: the connection drops, and the leader behind the next one refuses this store's protocol.
      leader.connections[0]!.drop();
      (await connection(t, leader, 1)).refuse();
      await waitUntil(t, () => lease.signal.aborted, 'The key must be lost');
      await delay(settle);

      // Assert: no leader heard the reassert, so another holder may have the
      // key; releasing it then has nothing left to release.
      assert.ok(
        lease.signal.reason instanceof LockLostError,
        `The lease must say the key is lost, not ${String(lease.signal.reason)}`,
      );
      assert.equal(lease.signal.reason.key, 'product:42');
      await assert.doesNotReject(async () => lease[Symbol.asyncDispose]());
      assert.deepEqual(
        unhandled,
        [],
        'A refused reconnect must not become an unhandled rejection',
      );
    } finally {
      process.off('unhandledRejection', collect);
    }
  });

  test('a task whose key is lost while it runs is told before it ends, and its caller then gets LockLostError', async (t) => {
    // Arrange: a task holds a key through the Mutex.
    await using follower = await followerOfStandIn();
    const { leader, store } = follower;
    const timeline: string[] = [];
    const leased = Promise.withResolvers<Lease>();
    const finish = Promise.withResolvers<void>();
    const running = new Mutex(store)
      .acquire('product:42', async (lease) => {
        lease.signal.addEventListener('abort', () =>
          timeline.push(
            lease.signal.reason instanceof LockLostError
              ? `the task is told ${lease.signal.reason.key} is lost`
              : `unexpected reason: ${String(lease.signal.reason)}`,
          ),
        );
        leased.resolve(lease);
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
      const first = await connection(t, leader, 0);
      first.welcome();
      first.answer({
        op: 'granted',
        id: (await request(t, first, 0)).id,
        token: '1',
      });
      const lease = await leased.promise;

      // Act: while the task runs, the connection drops and the next leader refuses this store.
      first.drop();
      (await connection(t, leader, 1)).refuse();
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
      // Arrange: a task holds a key through the Mutex.
      await using follower = await followerOfStandIn();
      const { leader, store } = follower;
      const leased = Promise.withResolvers<Lease>();
      const finish = Promise.withResolvers<void>();
      let thrown: unknown;
      const running = new Mutex(store).acquire('product:42', async (lease) => {
        leased.resolve(lease);
        await finish.promise;
        thrown = failure(lease);
        throw thrown;
      });
      const ended = watch(running);

      try {
        const first = await connection(t, leader, 0);
        first.welcome();
        first.answer({
          op: 'granted',
          id: (await request(t, first, 0)).id,
          token: '1',
        });
        const lease = await leased.promise;

        // Act: the key is lost while the task runs, and then the task fails.
        first.drop();
        (await connection(t, leader, 1)).refuse();
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
        await waitUntil(
          t,
          () => ended.now.status !== 'pending',
          'The call must end',
        );
      }
    });
  }

  test('a task whose reassert the new leader rejects is told before it ends, and releases nothing', async (t) => {
    // Arrange: a task holds a key through the Mutex.
    await using follower = await followerOfStandIn();
    const { leader, store } = follower;
    const told = Promise.withResolvers<unknown>();
    const leased = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const running = watch(
      new Mutex(store).acquire('product:42', async (lease) => {
        lease.signal.addEventListener('abort', () =>
          told.resolve(lease.signal.reason),
        );
        leased.resolve();
        await finish.promise;
      }),
    );

    try {
      const first = await connection(t, leader, 0);
      first.welcome();
      first.answer({
        op: 'granted',
        id: (await request(t, first, 0)).id,
        token: '1',
      });
      await leased.promise;

      // Act: the connection drops, and the leader behind the next one rejects the reassert.
      first.drop();
      const second = await connection(t, leader, 1);
      second.welcome();
      const reassert = await request(t, second, 0);
      second.answer({ op: 'rejected', id: reassert.id });
      const reason = await Promise.race([
        told.promise,
        delay(2000, 'never told', { ref: false }),
      ]);
      finish.resolve();
      await waitUntil(
        t,
        () => running.now.status !== 'pending',
        'The call must end',
      );
      await delay(settle);

      // Assert: the task was told while it ran, the call reports the loss, and
      // the leader that refused the key is not asked to release it.
      assert.equal(reassert.op, 'reassert');
      assert.ok(reason instanceof LockLostError, String(reason));
      assert.equal(reason.key, 'product:42');
      const ended = running.now;
      assert.ok(
        ended.status === 'rejected' && ended.reason === reason,
        `The call must reject with the lease's LockLostError, not ${JSON.stringify(ended)}`,
      );
      assert.deepEqual(
        second.requests.filter((sent) => sent.op === 'release'),
        [],
        'A lost lease must not be released',
      );
    } finally {
      finish.resolve();
    }
  });
});

describe('A socket store whose caller gives up or disposes it', () => {
  test('an acquire given up before the connection opens never reaches the leader', async (t) => {
    // Arrange: an acquire waits for the leader to welcome the store.
    await using follower = await followerOfStandIn();
    const { leader, store } = follower;
    const giveUp = new AbortController();
    const acquiring = store.acquire('product:42', { signal: giveUp.signal });
    const first = await connection(t, leader, 0);

    // Act: the caller gives up, then the leader welcomes the store.
    giveUp.abort();
    await assert.rejects(acquiring, { name: 'AbortError' });
    first.welcome();
    await delay(settle);

    // Assert
    assert.deepEqual(
      first.requests,
      [],
      'A request given up before it was sent must never be sent',
    );
  });

  test('a grant that arrives after the caller gave up is cancelled and then released', async (t) => {
    // Arrange: an acquire reached the leader.
    await using follower = await followerOfStandIn();
    const { leader, store } = follower;
    const giveUp = new AbortController();
    const acquiring = store.acquire('product:42', { signal: giveUp.signal });
    const first = await connection(t, leader, 0);
    first.welcome();
    const acquire = await request(t, first, 0);

    // Act: the caller gives up, and the leader's grant crosses the cancel.
    giveUp.abort();
    await assert.rejects(acquiring, { name: 'AbortError' });
    const cancel = await request(t, first, 1);
    first.answer({ op: 'granted', id: acquire.id, token: '1' });
    const release = await request(t, first, 2);

    // Assert: the leader is told to cancel, and the key it granted anyway is given back.
    assert.equal(acquire.op, 'acquire');
    assert.deepEqual(cancel, { op: 'cancel', id: acquire.id });
    assert.deepEqual(release, { op: 'release', id: acquire.id });
  });

  test('a store disposed as its connection opens rejects its acquire, sends nothing, and closes that connection', async (t) => {
    // Arrange: an acquire waits for the first connection, and the store is disposed the moment it follows a leader.
    await using follower = await followerOfStandIn();
    const { leader, store } = follower;
    const acquiring = watch(store.acquire('product:42'));
    store.once('role', () => void store[Symbol.asyncDispose]());
    const first = await connection(t, leader, 0);

    // Act: the leader welcomes the store.
    first.welcome();
    await waitUntil(
      t,
      () => first.closed,
      'The store must close the connection',
    );
    await delay(settle);

    // Assert
    const ended = acquiring.now;
    assert.ok(
      ended.status === 'rejected' &&
        ended.reason instanceof Error &&
        /closed/.test(ended.reason.message),
      `A disposed store must reject its acquire as closed, not ${JSON.stringify(ended)}`,
    );
    assert.deepEqual(
      first.requests,
      [],
      'Nothing may be sent on a connection that opens as the store is disposed',
    );
    assert.equal(
      leader.connections.length,
      1,
      'A disposed store must not connect again',
    );
  });

  test('disposing a store rejects its waiting acquire, closes its connection, and does not connect again', async (t) => {
    // Arrange: an acquire reached a leader that does not answer it.
    await using follower = await followerOfStandIn();
    const { leader, store } = follower;
    const acquiring = watch(store.acquire('product:42'));
    const first = await connection(t, leader, 0);
    first.welcome();
    await request(t, first, 0);

    // Act
    await store[Symbol.asyncDispose]();

    // Assert: the waiter is rejected, the leader sees the connection close, and nothing comes back.
    await waitUntil(
      t,
      () => acquiring.now.status === 'rejected',
      'A waiting acquire must be rejected when its store is disposed',
    );
    await waitUntil(
      t,
      () => first.closed,
      'The store must close its connection',
    );
    const later = await Promise.race([
      store.acquire('product:42').then(
        () => 'granted',
        (error: unknown) => error,
      ),
      delay(settle, 'still waiting', { ref: false }),
    ]);
    assert.ok(
      later instanceof Error && /closed/.test(later.message),
      `A disposed store must refuse new calls at once, not ${String(later)}`,
    );
    await delay(settle);
    assert.equal(
      leader.connections.length,
      1,
      'A disposed store must not connect again',
    );
  });
});

/** Opens the store's first connection with a try that the leader answers busy, and gives back that connection. */
async function warmedUp(
  t: TestContext,
  leader: StandInLeader,
  store: SocketStore,
) {
  const warmUp = store.tryAcquire('warm-up');
  const first = await connection(t, leader, 0);
  first.welcome();
  first.answer({ op: 'busy', id: (await request(t, first, 0)).id });
  assert.equal(await warmUp, undefined);
  return first;
}

describe('A socket store that reconnects', () => {
  test('a try made while the store reconnects is asked of the new leader once', async (t) => {
    // Arrange: the first connection dropped, and the next one waits for its welcome.
    await using follower = await followerOfStandIn();
    const { leader, store } = follower;
    (await warmedUp(t, leader, store)).drop();
    const second = await connection(t, leader, 1);

    // Act
    const trying = store.tryAcquire('product:42');
    second.welcome();
    const sent = await request(t, second, 0);
    second.answer({ op: 'granted', id: sent.id, token: '1' });
    const lease = await trying;
    await delay(settle);

    // Assert: no leader said busy, so the new one decides, and it is asked once.
    assert.ok(
      lease,
      'A free key must be granted to a try made during a reconnect',
    );
    assert.deepEqual(
      second.requests.map((request) => request.op),
      ['try'],
      'The try must be sent once, and its grant kept',
    );
  });

  test('an acquire made while the store reconnects is sent once on the new connection', async (t) => {
    // Arrange: the first connection dropped, and the next one waits for its welcome.
    await using follower = await followerOfStandIn();
    const { leader, store } = follower;
    (await warmedUp(t, leader, store)).drop();
    const second = await connection(t, leader, 1);

    // Act
    watch(store.acquire('product:42'));
    second.welcome();
    await request(t, second, 0);
    await delay(settle);

    // Assert
    assert.deepEqual(
      second.requests.map((request) => request.op),
      ['acquire'],
      'The acquire must be sent exactly once',
    );
  });

  test('an acquire whose connection drops before it is answered is sent again once, and granted on the next connection', async (t) => {
    // Arrange: an acquire reached the first leader, which does not answer it.
    await using follower = await followerOfStandIn();
    const { leader, store } = follower;
    const acquiring = store.acquire('product:42');
    const first = await connection(t, leader, 0);
    first.welcome();
    const acquire = await request(t, first, 0);

    // Act: the connection drops, and the next leader grants the acquire it is sent.
    first.drop();
    const second = await connection(t, leader, 1);
    second.welcome();
    const resent = await request(t, second, 0);
    second.answer({ op: 'granted', id: resent.id, token: '1' });
    const lease = await acquiring;
    await delay(settle);

    // Assert
    assert.equal(lease.token.value, 1n);
    assert.deepEqual(resent, acquire, 'The same acquire must be sent again');
    assert.equal(
      second.requests.length,
      1,
      'The acquire must be sent again exactly once',
    );
  });

  test('a try in flight when its connection drops is answered busy, and not asked again', async (t) => {
    // Arrange: a try reached the first leader, which does not answer it.
    await using follower = await followerOfStandIn();
    const { leader, store } = follower;
    const trying = store.tryAcquire('product:42');
    const first = await connection(t, leader, 0);
    first.welcome();
    await request(t, first, 0);

    // Act: the connection drops, and the store follows the next leader.
    first.drop();
    const second = await connection(t, leader, 1);
    second.welcome();

    // Assert: a try is one attempt, and the leader that would have answered it is gone.
    assert.equal(
      await Promise.race([
        trying,
        delay(2000, 'still waiting', { ref: false }),
      ]),
      undefined,
      'A try in flight when its connection drops must be answered busy',
    );
    await delay(settle);
    assert.deepEqual(second.requests, [], 'A try must not be asked again');
  });

  test('after a reconnect, held keys are reasserted before waiting acquires are sent again', async (t) => {
    // Arrange: the store holds one key and waits for another.
    await using follower = await followerOfStandIn();
    const { leader, store } = follower;
    const acquiringHeld = store.acquire('held');
    const first = await connection(t, leader, 0);
    first.welcome();
    first.answer({
      op: 'granted',
      id: (await request(t, first, 0)).id,
      token: '7',
    });
    const lease = await acquiringHeld;
    watch(store.acquire('waiting'));
    await request(t, first, 1);

    // Act
    first.drop();
    const second = await connection(t, leader, 1);
    second.welcome();
    await request(t, second, 1);
    await delay(settle);

    // Assert
    assert.deepEqual(
      second.requests.map(({ op, key }) => [op, key]),
      [
        ['reassert', 'held'],
        ['acquire', 'waiting'],
      ],
    );
    assert.equal(lease.token.value, 7n);
    assert.equal(
      second.requests[0]!.token,
      '7',
      'The reassert must carry the token the key was granted with',
    );
  });

  test('a lease released while the store reconnects is not reasserted on the next connection', async (t) => {
    // Arrange: the store holds a key, its connection dropped, and the next one waits for its welcome.
    await using follower = await followerOfStandIn();
    const { leader, store } = follower;
    const lease = await holding(t, leader, store.acquire('product:42'));
    leader.connections[0]!.drop();
    const second = await connection(t, leader, 1);

    // Act: the lease is released with no open connection to tell, then the store follows the next leader.
    await lease[Symbol.asyncDispose]();
    second.welcome();
    await delay(settle);

    // Assert
    assert.deepEqual(
      second.requests,
      [],
      'A lease being released must never be reasserted after a reconnect',
    );
  });

  test('a look cut off by a lost connection is asked again of the next leader', async (t) => {
    // Arrange: a look reached the first leader, which does not answer it.
    await using follower = await followerOfStandIn();
    const { leader, store } = follower;
    const looking = store.isHeld('product:42');
    const first = await connection(t, leader, 0);
    first.welcome();
    await request(t, first, 0);

    // Act: the connection drops, and the next leader answers the look.
    first.drop();
    const second = await connection(t, leader, 1);
    second.welcome();
    const asked = await request(t, second, 0);
    second.answer({ op: 'held', id: asked.id, held: true });

    // Assert
    assert.equal(asked.op, 'isHeld');
    assert.equal(asked.key, 'product:42');
    assert.equal(await looking, true);
  });

  test('a look that the leader answers as unsupported rejects with UnsupportedRequestError', async (t) => {
    // Arrange: the leader lists the look in its welcome, then does not know it.
    await using follower = await followerOfStandIn();
    const { leader, store } = follower;
    const looking = store.isHeld('product:42');
    const first = await connection(t, leader, 0);
    first.welcome();
    const asked = await request(t, first, 0);

    // Act
    first.answer({ op: 'unsupported', id: asked.id });

    // Assert
    const ended = await Promise.race([
      looking.then(
        (held) => `answered ${held}`,
        (error: unknown) => error,
      ),
      delay(2000, 'still waiting', { ref: false }),
    ]);
    assert.ok(ended instanceof UnsupportedRequestError, String(ended));
    assert.equal(ended.op, 'isHeld');
    assert.equal(ended.key, 'product:42');
  });

  test('a store opens no connection until it is used, and opens one for two first calls', async (t) => {
    // Arrange: the store is only built.
    await using follower = await followerOfStandIn();
    const { leader, store } = follower;
    await delay(settle);
    assert.equal(
      leader.connections.length,
      0,
      'A store that is only built must not connect',
    );

    // Act: two calls arrive before any connection exists.
    watch(store.acquire('first'));
    watch(store.acquire('second'));
    const first = await connection(t, leader, 0);
    first.welcome();
    await request(t, first, 1);
    await delay(settle);

    // Assert
    assert.equal(
      leader.connections.length,
      1,
      'Two first calls must share one connection',
    );
    assert.deepEqual(
      first.requests.map(({ key }) => key),
      ['first', 'second'],
    );
  });
});

describe('A follower process through a reconnect', () => {
  test(
    'a follower process that waits stays alive through a reconnect, and exits by itself once its key is released',
    { timeout: 20_000 },
    async (t) => {
      // Arrange: a process waits for a key from its first call, before any connection exists.
      await using directory = await scratchDirectory();
      await using _term = await new LeaderElection(directory.path, {
        pollInterval: 10,
      }).campaign();
      await using leader = await standInLeader(directory.path);
      await using waiter = startWorker(
        `
					import { SocketStore } from ${JSON.stringify(indexUrl.href)};
					const store = new SocketStore(${JSON.stringify(directory.path)}, { pollInterval: 10 });
					const lease = await store.acquire('product:42');
					process.send({ type: 'granted' });
					await lease[Symbol.asyncDispose]();
				`,
        'waiter',
      );
      const first = await connection(t, leader, 0, newProcessTimeout);
      first.welcome();
      await request(t, first, 0);
      await delay(settle);
      assert.equal(
        waiter.exit,
        null,
        `A follower that waits must keep its process alive.\n${waiter.stderr}`,
      );

      // Act: the connection drops, and the next leader reads the acquire again.
      first.drop();
      const second = await connection(t, leader, 1);
      second.welcome();
      const resent = await request(t, second, 0);
      await delay(settle);

      // Assert: still alive while it waits, then ends by itself once granted and released.
      assert.equal(
        waiter.exit,
        null,
        `A follower that waits must keep its process alive through a reconnect.\n${waiter.stderr}`,
      );
      second.answer({ op: 'granted', id: resent.id, token: '1' });
      await waitUntil(
        t,
        () => waiter.exit !== null,
        () =>
          `A follower with nothing left to wait for must exit.\n${waiter.stderr}`,
        5000,
      );
      assert.deepEqual(waiter.exit, { code: 0, signal: null }, waiter.stderr);
      assert.ok(waiter.has('granted'));
      assert.deepEqual(
        second.requests.map(({ op }) => op),
        ['acquire', 'release'],
      );
    },
  );

  test(
    'a follower process that only holds keys lets its process exit after a reconnect',
    { timeout: 20_000 },
    async (t) => {
      // Arrange: a process holds a key, and stays alive only until the test says so.
      await using directory = await scratchDirectory();
      await using _term = await new LeaderElection(directory.path, {
        pollInterval: 10,
      }).campaign();
      await using leader = await standInLeader(directory.path);
      await using holder = startWorker(
        `
					import { SocketStore } from ${JSON.stringify(indexUrl.href)};
					process.once('message', () => {});
					const store = new SocketStore(${JSON.stringify(directory.path)}, { pollInterval: 10 });
					await store.acquire('product:42');
					process.send({ type: 'holding' });
				`,
        'holder',
      );
      const first = await connection(t, leader, 0, newProcessTimeout);
      first.welcome();
      first.answer({
        op: 'granted',
        id: (await request(t, first, 0)).id,
        token: '1',
      });
      await waitUntil(
        t,
        () => holder.has('holding'),
        () => `The follower must hold the key.\n${holder.stderr}`,
      );

      // Act: the connection drops, the next leader reads the reassert, and the process has nothing else to do.
      first.drop();
      const second = await connection(t, leader, 1);
      second.welcome();
      const reassert = await request(t, second, 0);
      holder.child.send('done');

      // Assert: holding a key alone does not keep the process alive.
      assert.equal(reassert.op, 'reassert');
      await waitUntil(
        t,
        () => holder.exit !== null,
        () =>
          `A follower that only holds keys must let its process exit.\n${holder.stderr}`,
        5000,
      );
      assert.deepEqual(holder.exit, { code: 0, signal: null }, holder.stderr);
    },
  );
});
