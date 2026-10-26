import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { type Socket, connect, createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { describe } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';
import { test } from '@zukhruf/testing/node';

import { Mutex } from '../../index.ts';
import { newProcessTimeout } from '../../testing/new-process-timeout.ts';
import { startWorker } from '../../testing/worker-process.ts';
import { ProtocolVersionError, type SocketRole, SocketStore } from './index.ts';

// Every process of every published version that shares a directory meets the
// others through the names and bytes below: the claim on leader.lock, the term
// in leader.epoch, the socket path, the hello and the refused answer. These
// tests spell them out instead of importing them, so a change that moves the
// code and changes one of them fails here: processes of two versions would
// then lead side by side, or never find each other, and no error would tell.
// The other messages are spelled out too: a change to one of them must change
// PROTOCOL_VERSION, so that the hello tells two versions apart.

const onUnixSockets = {
  skip:
    process.platform === 'win32'
      ? 'A socket store on Windows meets its leader on a named pipe'
      : false,
};

/** Holds the term in `directory` as a published leader does: an exclusive SQLite transaction on `leader.lock`. */
function holdTerm(directory: string) {
  const claim = new DatabaseSync(join(directory, 'leader.lock'), {
    timeout: 0,
  });
  claim.exec('BEGIN EXCLUSIVE');
  const release = () => {
    if (!claim.isOpen) return;
    claim.exec('ROLLBACK');
    claim.close();
  };
  return { release, [Symbol.dispose]: release };
}

/**
 * A leader of a published version on `<directory>/lock.sock`, as raw bytes:
 * `answer` sees each line of each connection, and whether it opens the connection.
 */
async function publishedLeader(
  directory: string,
  answer: (peer: Socket, line: string, opens: boolean) => void,
) {
  const peers = new Set<Socket>();
  const firstLines: string[] = [];
  const server = createServer((peer) => {
    peers.add(peer);
    peer.on('error', () => {});
    let opens = true;
    createInterface({ input: peer }).on('line', (line) => {
      if (opens) firstLines.push(line);
      answer(peer, line, opens);
      opens = false;
    });
  });
  server.listen(join(directory, 'lock.sock'));
  await once(server, 'listening');
  return {
    firstLines,
    [Symbol.asyncDispose]: async () => {
      for (const peer of peers) peer.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A process of a published version on `<directory>/lock.sock`: it sends `bytes` and keeps every byte the leader sends back. */
async function publishedPeer(directory: string, bytes: string) {
  const socket = connect(join(directory, 'lock.sock'));
  socket.on('error', () => {});
  let received = '';
  let closed = false;
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => (received += chunk));
  socket.once('close', () => (closed = true));
  await once(socket, 'connect');
  socket.write(bytes);
  return {
    socket,
    get received() {
      return received;
    },
    get closed() {
      return closed;
    },
    [Symbol.dispose]: () => socket.destroy(),
  };
}

/** A leader of this source, serving `directory`. */
async function leaderOf(directory: string) {
  const store = new SocketStore(directory, { pollInterval: 10 });
  await new Mutex(store).acquire('warm-up', async () => {});
  return store;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const outcome = (running: Promise<unknown>) =>
  running.then(
    () => 'granted' as const,
    (error: unknown) => error,
  );

describe('What a socket store shares with other versions in its directory', () => {
  test(
    'a store does not lead while another process holds the claim on leader.lock, and leads once it is released',
    { ...onUnixSockets, timeout: 10_000 },
    async () => {
      // Arrange: a published leader holds the term and serves nothing yet.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      using term = holdTerm(directory.path);
      await using store = new SocketStore(directory.path, { pollInterval: 10 });
      const roles: SocketRole[] = [];
      store.on('role', (role) => roles.push(role));
      const mutex = new Mutex(store);

      // Act
      const whileHeld = await outcome(
        mutex.acquire('product:42', async () => {}, {
          signal: AbortSignal.timeout(300),
        }),
      );
      const rolesWhileHeld = [...roles];
      term.release();
      const afterRelease = await outcome(
        mutex.acquire('product:42', async () => {}),
      );

      // Assert
      assert.notEqual(whileHeld, 'granted', 'The store led beside the term');
      assert.deepEqual(rolesWhileHeld, []);
      assert.equal(afterRelease, 'granted');
      assert.deepEqual(roles, ['leader']);
    },
  );

  test(
    'a store that leads holds the claim on leader.lock, so a candidate of a published version cannot take it',
    { ...onUnixSockets, timeout: 10_000 },
    async () => {
      // Arrange
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using _leader = await leaderOf(directory.path);
      const candidate = new DatabaseSync(join(directory.path, 'leader.lock'), {
        timeout: 0,
      });

      try {
        // Act: the candidate campaigns as a published one does.
        const campaign = (() => {
          try {
            candidate.exec('BEGIN EXCLUSIVE');
            return 'won';
          } catch (error) {
            return error;
          }
        })();

        // Assert: SQLITE_BUSY (5, in the low byte) is how a published candidate learns that it lost.
        assert.ok(
          campaign instanceof Error &&
            'errcode' in campaign &&
            typeof campaign.errcode === 'number' &&
            (campaign.errcode & 0xff) === 5,
          `A published candidate did not lose to the leader: ${String(campaign)}`,
        );
      } finally {
        if (candidate.isTransaction) candidate.exec('ROLLBACK');
        candidate.close();
      }
    },
  );

  test(
    'a store that leads after the term in leader.epoch takes the next epoch, records it as decimal text, and grants tokens of it',
    { ...onUnixSockets, timeout: 10_000 },
    async () => {
      // Arrange: the last leader in this directory, of a published version, recorded term 6.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await writeFile(join(directory.path, 'leader.epoch'), '6');
      await using store = new SocketStore(directory.path, {
        pollInterval: 10,
        graceWindow: 50,
      });

      // Act
      const token = await new Mutex(store).acquire(
        'product:42',
        async ({ token }) => token,
      );

      // Assert: the epoch is the high 32 bits of every token of the term.
      assert.equal(token.value >> 32n, 7n);
      assert.equal(
        await readFile(join(directory.path, 'leader.epoch'), 'utf8'),
        '7',
      );
    },
  );

  test(
    'a store follows a published leader on lock.sock with the published hello and the published requests',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange: a published leader holds the term, grants each acquire a token of its term 5, and answers each look that the key is held.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      using _term = holdTerm(directory.path);
      const granted = (5n << 32n) | 1n;
      const requests: Record<string, unknown>[] = [];
      await using leader = await publishedLeader(
        directory.path,
        (peer, line, opens) => {
          if (opens) {
            peer.write('{"op":"welcome"}\n');
            return;
          }
          const request: unknown = JSON.parse(line);
          if (!isRecord(request)) return;
          requests.push(request);
          const id = JSON.stringify(request.id);
          if (request.op === 'acquire') {
            peer.write(`{"op":"granted","id":${id},"token":"${granted}"}\n`);
          }
          if (request.op === 'isHeld') {
            peer.write(`{"op":"held","id":${id},"held":true}\n`);
          }
        },
      );
      await using store = new SocketStore(directory.path, {
        pollInterval: 10,
      });
      const roles: SocketRole[] = [];
      store.on('role', (role) => roles.push(role));
      const mutex = new Mutex(store);

      // Act: take the key, and look at it while holding it.
      const { token, answer } = await mutex.acquire(
        'product:42',
        async ({ token }) => ({
          token,
          answer: await mutex.isHeld('product:42'),
        }),
      );
      // A release has no answer, so the store sends it without waiting.
      await t.waitFor(
        () =>
          assert.ok(
            requests.some(({ op }) => op === 'release'),
            `Requests: ${JSON.stringify(requests)}`,
          ),
        { interval: 5, timeout: 2000 },
      );

      // Assert
      assert.deepEqual(leader.firstLines, ['{"op":"hello","version":1}']);
      assert.equal(token.value, granted);
      assert.deepEqual(roles, ['follower']);
      assert.equal(answer, true);
      assert.deepEqual(
        requests.map(({ op }) => op),
        ['acquire', 'isHeld', 'release'],
      );
      const [acquire] = requests;
      assert.equal(acquire?.key, 'product:42');
      assert.equal(typeof acquire?.id, 'string');
      assert.equal(requests.at(-1)?.id, acquire?.id);
    },
  );

  test(
    'a leader answers the published hello on lock.sock with the published welcome',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using _leader = await leaderOf(directory.path);

      // Act: a follower of a published version says hello.
      using follower = await publishedPeer(
        directory.path,
        '{"op":"hello","version":1}\n',
      );

      // Assert
      await t.waitFor(
        () =>
          assert.ok(
            follower.received.includes('\n'),
            `Got ${JSON.stringify(follower.received)}`,
          ),
        { interval: 5, timeout: 2000 },
      );
      assert.equal(follower.received, '{"op":"welcome"}\n');
    },
  );

  test(
    'a leader answers a hello of another version with the published refusal, and hangs up',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using _leader = await leaderOf(directory.path);

      // Act: a process of protocol version 2 says hello.
      using other = await publishedPeer(
        directory.path,
        '{"op":"hello","version":2}\n',
      );

      // Assert
      await t.waitFor(
        () =>
          assert.ok(
            other.closed,
            `The leader must hang up; got ${JSON.stringify(other.received)}`,
          ),
        { interval: 5, timeout: 2000 },
      );
      assert.equal(other.received, '{"op":"refused","version":1}\n');
    },
  );

  test(
    'a leader grants a published acquire with the published grant, and frees the key on a published release',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange: a new directory, so the leader's term is 1, and its warm-up took the first token of the term.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using _leader = await leaderOf(directory.path);
      const term = 1n << 32n;
      const lines = (received: string) => received.split('\n').length - 1;

      // Act: a follower of a published version takes the key, gives it back, and takes it again.
      using follower = await publishedPeer(
        directory.path,
        '{"op":"hello","version":1}\n{"op":"acquire","id":"a","key":"product:42"}\n',
      );
      await t.waitFor(
        () =>
          assert.ok(
            lines(follower.received) === 2,
            `Got ${JSON.stringify(follower.received)}`,
          ),
        { interval: 5, timeout: 2000 },
      );
      follower.socket.write(
        '{"op":"release","id":"a"}\n{"op":"acquire","id":"b","key":"product:42"}\n',
      );
      await t.waitFor(
        () =>
          assert.ok(
            lines(follower.received) === 3,
            `Got ${JSON.stringify(follower.received)}`,
          ),
        { interval: 5, timeout: 2000 },
      );

      // Assert
      assert.equal(
        follower.received,
        [
          '{"op":"welcome"}',
          `{"op":"granted","id":"a","token":"${term | 2n}"}`,
          `{"op":"granted","id":"b","token":"${term | 3n}"}`,
          '',
        ].join('\n'),
      );
    },
  );

  test(
    'a store refused by a leader of another protocol version rejects with the ProtocolVersionError of this package',
    { ...onUnixSockets, timeout: 10_000 },
    async () => {
      // Arrange: a leader of protocol version 2 holds the term and refuses every hello, as the published refusal does.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      using _term = holdTerm(directory.path);
      await using _leader = await publishedLeader(directory.path, (peer) =>
        peer.end('{"op":"refused","version":2}\n'),
      );
      await using store = new SocketStore(directory.path, { pollInterval: 10 });

      // Act
      const result = await outcome(
        new Mutex(store).acquire('product:42', async () => {}),
      );

      // Assert
      assert.ok(result instanceof ProtocolVersionError, String(result));
      assert.equal(result.theirs, 2);
      assert.equal(result.ours, 1);
    },
  );

  test(
    'a leader welcomes a hello of 1024 bytes and refuses one of 1025, not counting the newline',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange: two hellos padded with JSON whitespace to their full length.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using _leader = await leaderOf(directory.path);
      const helloOf = (bytes: number) =>
        `{"op":"hello","version":1${' '.repeat(bytes - 26)}}`;
      assert.equal(Buffer.byteLength(helloOf(1024)), 1024);

      // Act
      using tooLong = await publishedPeer(directory.path, `${helloOf(1025)}\n`);
      using longest = await publishedPeer(directory.path, `${helloOf(1024)}\n`);
      await t.waitFor(
        () =>
          assert.ok(
            longest.received.includes('\n'),
            `Got ${JSON.stringify(longest.received)}`,
          ),
        { interval: 5, timeout: 2000 },
      );
      await t.waitFor(
        () =>
          assert.ok(
            tooLong.closed,
            `The leader must hang up; got ${JSON.stringify(tooLong.received)}`,
          ),
        { interval: 5, timeout: 2000 },
      );

      // Assert
      assert.equal(longest.received, '{"op":"welcome"}\n');
      assert.equal(tooLong.received, '{"op":"refused","version":1}\n');
    },
  );

  test(
    'a store takes a directory whose socket path has 103 bytes, and refuses one of 104 bytes, counting bytes and not characters',
    { ...onUnixSockets, timeout: 10_000 },
    async () => {
      // Arrange: directory names in Arabic letters, which take two bytes each, so each path has fewer characters than bytes.
      await using scratch = await new TemporaryFiles().directory('mutex-test-');
      const withSocketPathOf = (bytes: number) => {
        const nameBytes =
          bytes - Buffer.byteLength(join(scratch.path, 'lock.sock')) - 1;
        assert.ok(
          nameBytes >= 2,
          `The scratch directory ${scratch.path} is too long for this test`,
        );
        return join(
          scratch.path,
          `${'ح'.repeat(Math.floor(nameBytes / 2))}${'x'.repeat(nameBytes % 2)}`,
        );
      };
      const longest = withSocketPathOf(103);
      const tooLong = withSocketPathOf(104);
      assert.equal(Buffer.byteLength(join(longest, 'lock.sock')), 103);
      assert.equal(Buffer.byteLength(join(tooLong, 'lock.sock')), 104);

      // Act
      await using store = new SocketStore(longest, { pollInterval: 10 });
      const taken = await outcome(
        new Mutex(store).acquire('product:42', async () => {}),
      );
      const refused = (() => {
        try {
          return new SocketStore(tooLong, { pollInterval: 10 });
        } catch (error) {
          return error;
        }
      })();

      // Assert
      assert.equal(taken, 'granted');
      assert.ok(refused instanceof RangeError, String(refused));
    },
  );
});

describe('What a socket store shares with other versions on Windows', () => {
  const mutexUrl = new URL('../../index.ts', import.meta.url);
  const socketUrl = new URL('./index.ts', import.meta.url);
  // A child process runs as on Windows. Outside Windows, `node:net` still
  // makes a Unix socket for a pipe name: a file of that name in the working
  // directory, so the child works in a scratch directory.
  const asOnWindows = [
    '--import',
    `data:text/javascript,${encodeURIComponent(
      "Object.defineProperty(process, 'platform', { value: 'win32' });",
    )}`,
  ];
  // Relative and in mixed case, as Windows paths may be. Its socket path would exceed 103 bytes, which only matters outside Windows.
  const directory = `Shared-Locks-${'X'.repeat(100)}`;
  /** The pipe of every published version: `mutex-` and the first 32 hex digits of the SHA-256 of the lowercased absolute directory. */
  const pipeFor = (absolute: string) =>
    `\\\\.\\pipe\\mutex-${createHash('sha256').update(absolute.toLowerCase()).digest('hex').slice(0, 32)}`;

  test(
    'a store says the published hello on the pipe named for its directory',
    { timeout: 15_000 },
    async (t) => {
      // Arrange: a leader of a published version listens on the pipe of the directory.
      await using scratch = await new TemporaryFiles().directory('mutex-test-');
      const pipe = pipeFor(resolve(scratch.path, directory));

      // Act
      await using follower = startWorker(
        `
        import { createServer } from 'node:net';
        import { createInterface } from 'node:readline';
        import { Mutex } from ${JSON.stringify(mutexUrl.href)};
        import { SocketStore } from ${JSON.stringify(socketUrl.href)};
        process.chdir(${JSON.stringify(scratch.path)});
        const leader = createServer((peer) => {
          peer.on('error', () => {});
          createInterface({ input: peer }).once('line', (line) => process.send({ type: 'hello', line }));
        });
        leader.listen(${JSON.stringify(pipe)}, () => {
          const store = new SocketStore(${JSON.stringify(directory)}, { pollInterval: 10 });
          store.on('role', (role) => process.send({ type: 'role', role }));
          void new Mutex(store).acquire('product:42', async () => {});
        });
      `,
        'windows-follower',
        { nodeOptions: asOnWindows },
      );
      await t.waitFor(
        () =>
          assert.ok(
            follower.has('hello') ||
              follower.has('role') ||
              follower.exit !== null,
            `No hello on ${pipe}. ${follower.stderr}`,
          ),
        { interval: 5, timeout: newProcessTimeout },
      );

      // Assert
      assert.equal(
        follower.find('hello')?.line,
        '{"op":"hello","version":1}',
        `Messages: ${JSON.stringify(follower.messages)} ${follower.stderr}`,
      );
    },
  );

  test(
    'a store that leads listens on the pipe named for its directory',
    { timeout: 15_000 },
    async (t) => {
      // Arrange
      await using scratch = await new TemporaryFiles().directory('mutex-test-');
      const pipe = pipeFor(resolve(scratch.path, directory));

      // Act: the store leads, and a follower of a published version says hello on the pipe.
      await using leader = startWorker(
        `
        import { connect } from 'node:net';
        import { Mutex } from ${JSON.stringify(mutexUrl.href)};
        import { SocketStore } from ${JSON.stringify(socketUrl.href)};
        process.chdir(${JSON.stringify(scratch.path)});
        const store = new SocketStore(${JSON.stringify(directory)}, { pollInterval: 10 });
        store.on('role', (role) => process.send({ type: 'role', role }));
        await new Mutex(store).acquire('warm-up', async () => {});
        const follower = connect(${JSON.stringify(pipe)});
        let received = '';
        follower.setEncoding('utf8');
        follower.on('data', (chunk) => {
          received += chunk;
          if (received.includes('\\n')) process.send({ type: 'answer', received });
        });
        follower.on('error', (error) => process.send({ type: 'failed', message: String(error) }));
        follower.write('{"op":"hello","version":1}\\n');
      `,
        'windows-leader',
        { nodeOptions: asOnWindows },
      );
      await t.waitFor(
        () =>
          assert.ok(
            leader.has('answer') ||
              leader.has('failed') ||
              leader.exit !== null,
            `No answer on ${pipe}. ${leader.stderr}`,
          ),
        { interval: 5, timeout: newProcessTimeout },
      );

      // Assert
      assert.equal(leader.find('role')?.role, 'leader');
      assert.equal(
        leader.find('answer')?.received,
        '{"op":"welcome"}\n',
        `Messages: ${JSON.stringify(leader.messages)} ${leader.stderr}`,
      );
    },
  );
});
