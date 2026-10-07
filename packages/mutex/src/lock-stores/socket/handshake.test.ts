import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type Socket, connect, createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ProtocolVersionError } from '../../index.ts';
import { LeaderElection } from '../../leader-election/leader-election.ts';
import { scratchDirectory } from '../../testing/scratch-directory.ts';
import { waitUntil } from '../../testing/wait-until.ts';
import { isLockRequest } from '../remote/protocol.ts';
import { PROTOCOL_VERSION } from './handshake.ts';
import { type SocketRole, SocketStore } from './socket-store.ts';

const onUnixSockets = {
  skip:
    process.platform === 'win32'
      ? 'The stand-in leader and client use the Unix socket path'
      : false,
};

/**
 * A stand-in leader on the store's socket path. It reads each line of each
 * connection and lets `answer` reply or hang up, as a leader that runs
 * another version would.
 */
async function standInLeader(
  directory: string,
  answer: (peer: Socket, line: string) => void,
) {
  const peers = new Set<Socket>();
  const server = createServer((peer) => {
    peers.add(peer);
    peer.on('error', () => {});
    createInterface({ input: peer }).on('line', (line) => answer(peer, line));
  });
  server.listen(join(directory, 'lock.sock'));
  await once(server, 'listening');
  return {
    [Symbol.asyncDispose]: async () => {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Sends `line` to the leader on the socket path, and reads its one answer before the connection ends. */
async function askLeader(directory: string, line: string) {
  const socket = connect(join(directory, 'lock.sock'));
  await once(socket, 'connect');
  socket.write(`${line}\n`);
  const lines: string[] = [];
  createInterface({ input: socket }).on('line', (answer) => lines.push(answer));
  // A leader that wrongly keeps the peer would never hang up; the answers so far then fail the test.
  await Promise.race([once(socket, 'close'), delay(2000)]);
  socket.destroy();
  return lines;
}

/** Whether `line` is a hello in this protocol, exactly as a store sends it. */
function isHello(line: string) {
  try {
    const hello: unknown = JSON.parse(line);
    return (
      typeof hello === 'object' &&
      hello !== null &&
      'op' in hello &&
      hello.op === 'hello' &&
      'version' in hello &&
      hello.version === PROTOCOL_VERSION
    );
  } catch {
    return false;
  }
}

const outcome = (acquiring: Promise<AsyncDisposable>) =>
  acquiring.then(
    async (lease) => {
      await lease[Symbol.asyncDispose]();
      return 'granted' as const;
    },
    (error: unknown) => error,
  );

/**
 * A process of package version 0.3.0 or earlier, as a leader sees it: it opens
 * each connection with `line` instead of a hello, and it connects again at
 * once when the leader closes the connection. A connect that fails stops it,
 * because nothing listens then.
 */
async function processWithoutHello(directory: string, line: string) {
  const answers: string[] = [];
  let closes = 0;
  let stopped = false;
  const open = () => {
    const socket = connect(join(directory, 'lock.sock'));
    socket.on('error', () => {});
    socket.once('connect', () => {
      createInterface({ input: socket }).on('line', (answer) =>
        answers.push(answer),
      );
      socket.write(`${line}\n`);
      socket.once('close', () => {
        closes++;
        if (!stopped) current = open();
      });
    });
    return socket;
  };
  let current = open();
  await once(current, 'connect');
  return {
    answers,
    get closes() {
      return closes;
    },
    [Symbol.dispose]() {
      stopped = true;
      current.destroy();
    },
  };
}

describe('Socket store protocol handshake', () => {
  test(
    'a store whose leader speaks another protocol version fails its acquire, naming both versions',
    onUnixSockets,
    async () => {
      // Arrange: a leader that holds the term answers every hello with its own version, 99.
      await using directory = await scratchDirectory();
      await using _term = await new LeaderElection(directory.path, {
        pollInterval: 10,
      }).campaign();
      await using _leader = await standInLeader(directory.path, (peer, line) =>
        // It answers only a well-formed hello, so a store that sends anything else fails another way.
        isHello(line)
          ? peer.end(`${JSON.stringify({ op: 'refused', version: 99 })}\n`)
          : peer.destroy(),
      );
      await using store = new SocketStore(directory.path, { pollInterval: 10 });

      // Act
      const result = await outcome(store.acquire('product:42'));

      // Assert
      assert.ok(result instanceof ProtocolVersionError, String(result));
      assert.equal(result.theirs, 99);
      assert.match(result.message, /version 99/);
      assert.equal(result.ours, PROTOCOL_VERSION);
      assert.match(result.message, new RegExp(`version ${PROTOCOL_VERSION}`));
    },
  );

  test(
    'a store whose leader keeps its term but hangs up on the handshake fails its acquire',
    onUnixSockets,
    async () => {
      // Arrange: a leader from before the handshake holds the term and hangs up on every hello.
      await using directory = await scratchDirectory();
      await using _term = await new LeaderElection(directory.path, {
        pollInterval: 10,
      }).campaign();
      await using _leader = await standInLeader(directory.path, (peer) =>
        peer.destroy(),
      );
      await using store = new SocketStore(directory.path, { pollInterval: 10 });

      // Act
      const result = await outcome(
        store.acquire('product:42', { signal: AbortSignal.timeout(5000) }),
      );

      // Assert: it fails loudly instead of trying to connect forever.
      assert.ok(result instanceof ProtocolVersionError, String(result));
      assert.equal(result.theirs, undefined);
    },
  );

  test(
    'a store whose leader hangs up while it stops leads in its place',
    onUnixSockets,
    async () => {
      // Arrange: a stopping leader hangs up on the hello and ends its term a moment later, as a real shutdown does.
      await using directory = await scratchDirectory();
      const term = await new LeaderElection(directory.path, {
        pollInterval: 10,
      }).campaign();
      assert.ok(term, 'The stand-in must win the first term');
      await using _leader = await standInLeader(directory.path, (peer) => {
        peer.destroy();
        setTimeout(() => void term.resign(), 100);
      });
      await using store = new SocketStore(directory.path, { pollInterval: 10 });
      const roles: SocketRole[] = [];
      store.on('role', (role) => roles.push(role));

      try {
        // Act
        const result = await outcome(
          store.acquire('product:42', { signal: AbortSignal.timeout(5000) }),
        );

        // Assert
        assert.equal(result, 'granted');
        assert.deepEqual(roles, ['leader']);
      } finally {
        await term.resign();
      }
    },
  );

  test(
    'a store that reaches a hung-up socket with no leader behind it leads',
    onUnixSockets,
    async () => {
      // Arrange: something hangs up on the socket path, but nobody holds the term.
      await using directory = await scratchDirectory();
      await using _leader = await standInLeader(directory.path, (peer) =>
        peer.destroy(),
      );
      await using store = new SocketStore(directory.path, { pollInterval: 10 });
      const roles: SocketRole[] = [];
      store.on('role', (role) => roles.push(role));

      // Act
      const result = await outcome(
        store.acquire('product:42', { signal: AbortSignal.timeout(5000) }),
      );

      // Assert
      assert.equal(result, 'granted');
      assert.deepEqual(roles, ['leader']);
    },
  );

  for (const [what, line] of [
    ['another protocol version', JSON.stringify({ op: 'hello', version: 99 })],
    // Any hello gets an answer: a process of a later protocol must learn that it differs, not wait.
    ['no protocol version', JSON.stringify({ op: 'hello' })],
  ] as const) {
    test(
      `a leader refuses a process whose hello gives ${what}, and its followers keep working`,
      onUnixSockets,
      async () => {
        // Arrange: a real leader serves the directory, and a follower uses it.
        await using directory = await scratchDirectory();
        await using leader = new SocketStore(directory.path, {
          pollInterval: 10,
        });
        await (await leader.acquire('warm-up'))[Symbol.asyncDispose]();
        await using follower = new SocketStore(directory.path, {
          pollInterval: 10,
        });
        await (await follower.acquire('warm-up'))[Symbol.asyncDispose]();

        // Act
        const answers = await askLeader(directory.path, line);

        // Assert: the leader names its own version and hangs up on that process only.
        assert.equal(answers.length, 1);
        const [answer] = answers;
        assert.ok(answer);
        const refusal: unknown = JSON.parse(answer);
        assert.ok(
          typeof refusal === 'object' &&
            refusal !== null &&
            'op' in refusal &&
            refusal.op === 'refused' &&
            'version' in refusal &&
            refusal.version === PROTOCOL_VERSION,
          answer,
        );
        assert.equal(await outcome(follower.acquire('product:42')), 'granted');
      },
    );
  }

  for (const [what, line] of [
    ['a line that is not JSON', 'not json'],
    [
      'a lock request with no hello',
      JSON.stringify({ op: 'acquire', id: 'x', key: 'product:42' }),
    ],
  ] as const) {
    test(
      `a leader gives no answer to a process that opens with ${what}, and keeps it connected until its term ends`,
      onUnixSockets,
      async (t) => {
        // Arrange: a real leader serves the directory, and a follower uses it.
        await using directory = await scratchDirectory();
        await using leader = new SocketStore(directory.path, {
          pollInterval: 10,
        });
        await (await leader.acquire('warm-up'))[Symbol.asyncDispose]();
        await using follower = new SocketStore(directory.path, {
          pollInterval: 10,
        });
        await (await follower.acquire('warm-up'))[Symbol.asyncDispose]();

        // Act: a process that connects again after each hang-up opens with that line.
        using old = await processWithoutHello(directory.path, line);
        const followed = await outcome(follower.acquire('product:42'));
        // A leader that hangs up starts the loop of connections at once; this time lets it show.
        await delay(200);

        // Assert: no answer and no hang-up, and the request was never served.
        assert.equal(old.closes, 0, `The leader hung up ${old.closes} times`);
        assert.deepEqual(old.answers, []);
        assert.equal(followed, 'granted');
        // The end of the term still closes the connection, so the process was connected all along.
        await leader[Symbol.asyncDispose]();
        await waitUntil(
          t,
          () => old.closes === 1,
          'The end of the term must close the connection',
        );
      },
    );
  }

  test(
    'a leader closes its side when a process that it gave no answer closes its side',
    onUnixSockets,
    async (t) => {
      // Arrange: a real leader, and a process that opens with a lock request and no hello.
      await using directory = await scratchDirectory();
      await using leader = new SocketStore(directory.path, {
        pollInterval: 10,
      });
      await (await leader.acquire('warm-up'))[Symbol.asyncDispose]();
      const socket = connect({
        path: join(directory.path, 'lock.sock'),
        allowHalfOpen: true,
      });
      await once(socket, 'connect');
      const answers: string[] = [];
      createInterface({ input: socket }).on('line', (answer) =>
        answers.push(answer),
      );
      let leaderClosed = false;
      socket.once('end', () => (leaderClosed = true));

      try {
        // Act: the process sends two requests at once, as 0.3.0 does on connect, and exits.
        // A paused leader keeps the second request unread, and then it never reads the close behind it.
        socket.end(
          `${JSON.stringify({ op: 'acquire', id: 'x', key: 'product:42' })}\n${JSON.stringify({ op: 'acquire', id: 'y', key: 'report-daily' })}\n`,
        );

        // Assert: the leader sees the close, so the connection does not stay open until the term ends.
        await waitUntil(
          t,
          () => leaderClosed,
          'The leader must close its side once the process closes its side',
        );
        assert.deepEqual(answers, []);
      } finally {
        socket.destroy();
      }
    },
  );

  test(
    'a store hung up on during a failover follows the leader that took over',
    onUnixSockets,
    async () => {
      // Arrange: when the store says hello, the stopping leader ends its term, another store takes it over, and only then does the stopping leader hang up.
      await using directory = await scratchDirectory();
      const term = await new LeaderElection(directory.path, {
        pollInterval: 10,
      }).campaign();
      assert.ok(term, 'The stand-in must win the first term');
      await using successor = new SocketStore(directory.path, {
        pollInterval: 10,
      });
      let stopping = true;
      await using _leader = await standInLeader(directory.path, (peer) => {
        // Only the store's hello finds the leader stopping; it hangs up on everyone after that.
        if (!stopping) return peer.destroy();
        stopping = false;
        void (async () => {
          await term.resign();
          await (await successor.acquire('warm-up'))[Symbol.asyncDispose]();
          peer.destroy();
        })();
      });
      await using store = new SocketStore(directory.path, { pollInterval: 10 });
      const roles: SocketRole[] = [];
      store.on('role', (role) => roles.push(role));

      // Act
      const result = await outcome(
        store.acquire('product:42', { signal: AbortSignal.timeout(10_000) }),
      );

      // Assert: the hang-up came from a leader that stopped, so the store follows its successor.
      assert.equal(result, 'granted');
      assert.deepEqual(roles, ['follower']);
    },
  );

  test(
    'a holder hung up on by its stopping leader keeps its key from a successor that already leads',
    onUnixSockets,
    async () => {
      // Arrange: the store holds a key from the stand-in leader. When the
      // store connects again, the stand-in keeps that hello unanswered,
      // because it stops: it ends its term, and a successor takes it over.
      await using directory = await scratchDirectory();
      const term = await new LeaderElection(directory.path, {
        pollInterval: 10,
      }).campaign();
      assert.ok(term, 'The stand-in must win the first term');
      let hellos = 0;
      let first: Socket | undefined;
      const reconnected = Promise.withResolvers<Socket>();
      await using _leader = await standInLeader(
        directory.path,
        (peer, line) => {
          if (isHello(line)) {
            hellos++;
            if (hellos === 1) {
              first = peer;
              peer.write(`${JSON.stringify({ op: 'welcome' })}\n`);
            } else if (hellos === 2) reconnected.resolve(peer);
            else peer.destroy();
            return;
          }
          const request: unknown = JSON.parse(line);
          if (isLockRequest(request) && request.op === 'acquire') {
            const token = String((term.epoch << 32n) | 1n);
            peer.write(
              `${JSON.stringify({ op: 'granted', id: request.id, token })}\n`,
            );
          }
        },
      );
      await using store = new SocketStore(directory.path, { pollInterval: 10 });
      await using successor = new SocketStore(directory.path, {
        pollInterval: 10,
      });
      const lease = await store.acquire('product:42');
      const journal: string[] = [];

      // Act: the stand-in stops while the store holds the key, and the
      // successor leads before the stand-in hangs up on the store.
      first?.destroy();
      const hungUp = await reconnected.promise;
      await term.resign();
      const leading = once(successor, 'role');
      const waiting = outcome(
        successor.acquire('product:42').then((granted) => {
          journal.push('waiter:enter');
          return granted;
        }),
      );
      await leading;
      hungUp.destroy();
      // Another key is granted only after the grace window. After it, the
      // successor would grant the waiter if the store had not reasserted its key.
      await (await successor.acquire('other'))[Symbol.asyncDispose]();
      const kept = !lease.signal.aborted;
      journal.push('holder:leave');
      await lease[Symbol.asyncDispose]();
      const waited = await waiting;

      // Assert: the store reasserted its key in time, so the waiter waited for the release.
      assert.deepEqual(
        journal,
        ['holder:leave', 'waiter:enter'],
        'A waiter entered while the holder still held the key',
      );
      assert.ok(kept, 'The holder must keep its key across the failover');
      assert.equal(waited, 'granted');
    },
  );

  test(
    'a leader reads a request that arrives with the hello in one piece',
    onUnixSockets,
    async (t) => {
      // Arrange: a real leader serves the directory.
      await using directory = await scratchDirectory();
      await using leader = new SocketStore(directory.path, {
        pollInterval: 10,
      });
      await (await leader.acquire('warm-up'))[Symbol.asyncDispose]();
      const socket = connect(join(directory.path, 'lock.sock'));
      await once(socket, 'connect');
      const answers: string[] = [];
      createInterface({ input: socket }).on('line', (line) =>
        answers.push(line),
      );

      try {
        // Act: the hello and an acquire leave in one write.
        socket.write(
          `${JSON.stringify({ op: 'hello', version: PROTOCOL_VERSION })}\n${JSON.stringify({ op: 'acquire', id: 'a', key: 'product:42' })}\n`,
        );

        // Assert: the leader welcomes the peer and still sees the request behind the hello.
        await waitUntil(
          t,
          () => answers.length >= 2,
          `Got ${answers.join(' | ')}`,
        );
        assert.deepEqual(
          answers.map((line) => JSON.parse(line).op),
          ['welcome', 'granted'],
        );
      } finally {
        socket.destroy();
      }
    },
  );

  test(
    'a store that closes while its leader never answers the hello gives the connection up',
    onUnixSockets,
    async (t) => {
      // Arrange: a leader that holds the term reads the hello and never answers.
      await using directory = await scratchDirectory();
      await using _term = await new LeaderElection(directory.path, {
        pollInterval: 10,
      }).campaign();
      let peerClosed = false;
      let greeted = false;
      await using _leader = await standInLeader(directory.path, (peer) => {
        greeted = true;
        peer.once('close', () => (peerClosed = true));
      });
      const store = new SocketStore(directory.path, { pollInterval: 10 });
      const acquiring = outcome(store.acquire('product:42'));
      await waitUntil(t, () => greeted, 'The store must say hello');

      // Act
      await store[Symbol.asyncDispose]();

      // Assert: closing does not wait for an answer that never comes, and the connection is closed.
      assert.ok((await acquiring) instanceof Error);
      await waitUntil(
        t,
        () => peerClosed,
        'The store must close the connection',
      );
    },
  );

  test(
    'a leader lets go of a peer it refused, even one that keeps its side open',
    onUnixSockets,
    async (t) => {
      // Arrange: a real leader, and a peer that opens with another version and never hangs up.
      await using directory = await scratchDirectory();
      await using leader = new SocketStore(directory.path, {
        pollInterval: 10,
      });
      await (await leader.acquire('warm-up'))[Symbol.asyncDispose]();
      const socket = connect({
        path: join(directory.path, 'lock.sock'),
        allowHalfOpen: true,
      });
      await once(socket, 'connect');
      let released = false;
      // Writing to a leader that let go fails; writing to one that only paused its side does not.
      socket.on('error', () => (released = true));
      socket.on('close', () => (released = true));
      socket.resume();

      // Act: after its hello, the peer keeps writing instead of hanging up.
      socket.write(`${JSON.stringify({ op: 'hello', version: 99 })}\n`);
      const writing = setInterval(() => {
        if (socket.writable) socket.write('more\n');
      }, 10);

      try {
        // Assert
        await waitUntil(
          t,
          () => released,
          'The leader must close its side of a peer it refused',
        );
      } finally {
        clearInterval(writing);
        socket.destroy();
      }
    },
  );
});
