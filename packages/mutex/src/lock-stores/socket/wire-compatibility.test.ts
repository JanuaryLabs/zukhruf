import assert from 'node:assert/strict';
import { hash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { type Socket, connect, createServer } from 'node:net';
import { join, resolve, win32 } from 'node:path';
import { describe } from 'node:test';

import { Latch, untilAborted } from '@zukhruf/async';
import { FileLock, TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import { NodeCommand } from '@zukhruf/process';
import { UnchangedJournal, open } from '@zukhruf/sqlite-open';
import { waitFor } from '@zukhruf/testing/async';

import { Mutex } from '../../index.ts';
import { linesOf } from '../../testing/lines-of.ts';
import { onUnixSockets } from '../../testing/on-unix-sockets.ts';
import { taskOutcome } from '../../testing/outcome.ts';
import { standInServer } from '../../testing/stand-in-server.ts';
import { ProtocolVersionError, type SocketRole, SocketStore } from './index.ts';

// Every process of every published version that shares a directory meets the
// others through the names and bytes below: the claim on leader.lock, the term
// in leader.epoch, the socket path, the hello and the refused answer. These
// tests spell them out instead of importing them, so a change that moves the
// code and changes one of them fails here: processes of two versions would
// then lead side by side, or never find each other, and no error would tell.
// The other messages are spelled out too: a change to one of them must change
// PROTOCOL_VERSION, so that the hello tells two versions apart. The files of
// a session in the folder `sessions` are spelled out as well: a new leader
// learns from them which processes it waits for (ADR 0033).

/** The hello of this protocol version: the version, and the random id of the session of the store. */
const helloLine =
  /^\{"op":"hello","version":3,"session":"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"\}$/;

/** Holds the term in `directory` as a published leader does: an exclusive SQLite transaction on `leader.lock`. */
function holdTerm(directory: string) {
  const claim = open(join(directory, 'leader.lock'), {
    journal: new UnchangedJournal(),
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
  const firstLines: string[] = [];
  const server = await standInServer(join(directory, 'lock.sock'), (peer) => {
    let opens = true;
    linesOf(peer).on('line', (line) => {
      if (opens) firstLines.push(line);
      answer(peer, line, opens);
      opens = false;
    });
  });
  return Object.assign(server, { firstLines });
}

/** A process of a published version on `<directory>/lock.sock`: it sends `bytes` and keeps every byte the leader sends back. */
async function publishedPeer(directory: string, bytes: string) {
  const socket = connect(join(directory, 'lock.sock'));
  socket.on('error', () => {});
  let received = '';
  const closed = new Latch();
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => (received += chunk));
  socket.once('close', () => closed.open());
  await once(socket, 'connect');
  socket.write(bytes);
  return {
    socket,
    get received() {
      return received;
    },
    /** Opens when the leader hung up. */
    closed,
    [Symbol.dispose]: () => socket.destroy(),
  };
}

/** A leader of this source, serving `directory`. */
async function leaderOf(directory: string) {
  const store = new SocketStore(directory, {
    clock: globalThis,
  });
  await new Mutex(store).acquire('warm-up', async () => {});
  return store;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

describe('What a socket store shares with other versions in its directory', () => {
  test(
    'a store does not lead while another process holds the claim on leader.lock, and leads once it is released',
    { ...onUnixSockets },
    async () => {
      // Arrange: a published leader holds the term and serves nothing yet.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      using term = holdTerm(directory.path);
      await using store = new SocketStore(directory.path, {
        clock: globalThis,
      });
      const roles: SocketRole[] = [];
      store.on('role', (role) => roles.push(role));
      const mutex = new Mutex(store);

      const limit = AbortSignal.timeout(300);

      // Act
      const whileHeld = await taskOutcome(
        mutex.acquire('product:42', async () => {}, { signal: limit }),
      );
      const rolesWhileHeld = [...roles];
      term.release();
      const afterRelease = await taskOutcome(
        mutex.acquire('product:42', async () => {}),
      );

      // Assert
      assert.equal(whileHeld, limit.reason, 'The store led beside the term');
      assert.deepEqual(rolesWhileHeld, []);
      assert.equal(afterRelease, 'granted');
      assert.deepEqual(roles, ['leader']);
    },
  );

  test(
    'a store that leads holds the claim on leader.lock, so a candidate of a published version cannot take it',
    { ...onUnixSockets },
    async () => {
      // Arrange
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using _leader = await leaderOf(directory.path);
      const candidate = open(join(directory.path, 'leader.lock'), {
        journal: new UnchangedJournal(),
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
          Error.isError(campaign) &&
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
    { ...onUnixSockets },
    async () => {
      // Arrange: the last leader in this directory, of a published version, recorded term 6.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await writeFile(join(directory.path, 'leader.epoch'), '6');
      await using store = new SocketStore(directory.path, {
        clock: globalThis,
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
    'a store follows a leader on lock.sock with the hello, the end-of-reasserts marker and the requests of this protocol, after it records its session',
    { ...onUnixSockets },
    async (t) => {
      // Arrange: a leader of this protocol holds the term, grants each acquire a token of its term 5, and answers each look that the key is held.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      using _term = holdTerm(directory.path);
      const granted = (5n << 32n) | 1n;
      const requests: Record<string, unknown>[] = [];
      const lines: string[] = [];
      await using leader = await publishedLeader(
        directory.path,
        (peer, line, opens) => {
          if (opens) {
            peer.write('{"op":"welcome"}\n');
            return;
          }
          lines.push(line);
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
        clock: globalThis,
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
      await waitFor(
        () =>
          assert.ok(
            requests.some(({ op }) => op === 'release'),
            `Requests: ${JSON.stringify(requests)}`,
          ),
        { signal: t.signal },
      );

      const [hello] = leader.firstLines;
      const session = helloLine.exec(hello ?? '')?.[1];
      const sessions = join(directory.path, 'sessions');
      const files = (await readdir(sessions)).toSorted();
      const record = await readFile(join(sessions, `${session}.json`), 'utf8');
      const presence = FileLock.check(join(sessions, `${session}.presence`));

      // Assert
      assert.ok(session, `The hello must name a session, got ${hello}`);
      assert.deepEqual(leader.firstLines, [hello]);
      assert.deepEqual(files, [`${session}.json`, `${session}.presence`]);
      assert.equal(
        record,
        `{"leaseDuration":15000,"processId":${process.pid}}`,
      );
      assert.equal(presence, 'locked');
      assert.equal(lines[0], '{"op":"reasserted"}');
      assert.equal(token.value, granted);
      assert.deepEqual(roles, ['follower']);
      assert.equal(answer, true);
      assert.deepEqual(
        requests.map(({ op }) => op),
        ['reasserted', 'acquire', 'isHeld', 'release'],
      );
      const acquire = requests[1];
      assert.equal(acquire?.key, 'product:42');
      assert.equal(typeof acquire?.id, 'string');
      assert.equal(requests.at(-1)?.id, acquire?.id);
    },
  );

  test(
    'a leader answers the hello of this protocol on lock.sock with the published welcome',
    { ...onUnixSockets },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using _leader = await leaderOf(directory.path);

      // Act: a follower of this protocol says hello.
      using follower = await publishedPeer(
        directory.path,
        '{"op":"hello","version":3,"session":"d3b07384-d9a0-4c9b-8f6e-1a2b3c4d5e6f"}\n',
      );

      // Assert
      await waitFor(
        () =>
          assert.ok(
            follower.received.includes('\n'),
            `Got ${JSON.stringify(follower.received)}`,
          ),
        { signal: t.signal },
      );
      assert.equal(follower.received, '{"op":"welcome"}\n');
    },
  );

  test(
    'a leader answers a hello of another version with the published refusal, and hangs up',
    { ...onUnixSockets },
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
      // The leader must hang up.
      await untilAborted(other.closed.wait(), t.signal);
      assert.equal(other.received, '{"op":"refused","version":3}\n');
    },
  );

  test(
    'a leader grants a published acquire with the published grant, and frees the key on a published release',
    { ...onUnixSockets },
    async (t) => {
      // Arrange: a new directory, so the leader's term is 1, and its warm-up took the first token of the term.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using _leader = await leaderOf(directory.path);
      const term = 1n << 32n;
      const lines = (received: string) => received.split('\n').length - 1;

      // Act: a follower of this protocol takes the key, gives it back, and takes it again; nothing answers its marker.
      using follower = await publishedPeer(
        directory.path,
        '{"op":"hello","version":3,"session":"d3b07384-d9a0-4c9b-8f6e-1a2b3c4d5e6f"}\n{"op":"reasserted"}\n{"op":"acquire","id":"a","key":"product:42"}\n',
      );
      await waitFor(
        () =>
          assert.ok(
            lines(follower.received) === 2,
            `Got ${JSON.stringify(follower.received)}`,
          ),
        { signal: t.signal },
      );
      follower.socket.write(
        '{"op":"release","id":"a"}\n{"op":"acquire","id":"b","key":"product:42"}\n',
      );
      await waitFor(
        () =>
          assert.ok(
            lines(follower.received) === 3,
            `Got ${JSON.stringify(follower.received)}`,
          ),
        { signal: t.signal },
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
    { ...onUnixSockets },
    async () => {
      // Arrange: a leader of protocol version 2 holds the term and refuses every hello, as the published refusal does.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      using _term = holdTerm(directory.path);
      await using _leader = await publishedLeader(directory.path, (peer) =>
        peer.end('{"op":"refused","version":2}\n'),
      );
      await using store = new SocketStore(directory.path, {
        clock: globalThis,
      });

      // Act
      const result = await taskOutcome(
        new Mutex(store).acquire('product:42', async () => {}),
      );

      // Assert
      assert.ok(result instanceof ProtocolVersionError, String(result));
      assert.equal(result.theirs, 2);
      assert.equal(result.ours, 3);
    },
  );

  test(
    'a leader welcomes a hello of 1024 bytes and refuses one of 1025, not counting the newline',
    { ...onUnixSockets },
    async (t) => {
      // Arrange: two hellos padded with JSON whitespace to their full length.
      await using directory = await new TemporaryFiles().directory(
        'mutex-test-',
      );
      await using _leader = await leaderOf(directory.path);
      const helloOf = (bytes: number) =>
        `{"op":"hello","version":3,"session":"p"${' '.repeat(bytes - 40)}}`;
      assert.equal(Buffer.byteLength(helloOf(1024)), 1024);

      // Act
      using tooLong = await publishedPeer(directory.path, `${helloOf(1025)}\n`);
      using longest = await publishedPeer(directory.path, `${helloOf(1024)}\n`);
      await waitFor(
        () =>
          assert.ok(
            longest.received.includes('\n'),
            `Got ${JSON.stringify(longest.received)}`,
          ),
        { signal: t.signal },
      );
      // The leader must hang up.
      await untilAborted(tooLong.closed.wait(), t.signal);

      // Assert
      assert.equal(longest.received, '{"op":"welcome"}\n');
      assert.equal(tooLong.received, '{"op":"refused","version":3}\n');
    },
  );

  test(
    'a store takes a directory whose socket path has 103 bytes on macOS and 107 on Linux, and refuses one byte more, counting bytes and not characters',
    { ...onUnixSockets },
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
      // One byte less than sun_path, for its ending zero byte.
      const limit = process.platform === 'linux' ? 107 : 103;
      const longest = withSocketPathOf(limit);
      const tooLong = withSocketPathOf(limit + 1);
      assert.equal(Buffer.byteLength(join(longest, 'lock.sock')), limit);
      assert.equal(Buffer.byteLength(join(tooLong, 'lock.sock')), limit + 1);

      // Act
      await using store = new SocketStore(longest, {
        clock: globalThis,
      });
      const taken = await taskOutcome(
        new Mutex(store).acquire('product:42', async () => {}),
      );
      const refused = (() => {
        try {
          return new SocketStore(tooLong, {
            clock: globalThis,
          });
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
  // Relative and in mixed case, as Windows paths may be. Its socket path would exceed the limit of macOS and Linux, which only matters outside Windows.
  const directory = `Shared-Locks-${'X'.repeat(100)}`;
  /**
   * The pipe of every version after 0.8.18: `zukhruf-mutex-` and the first 32
   * hex digits of the SHA-256 of the lowercased absolute socket path
   * `<directory>\lock.sock`. Versions up to 0.8.18 named it `mutex-` and the
   * hash of the directory, so they do not meet these versions on Windows.
   */
  const pipeFor = (socketPath: string) =>
    `\\\\.\\pipe\\zukhruf-mutex-${hash('sha256', win32.resolve(socketPath).toLowerCase()).slice(0, 32)}`;

  test('a store says the hello of this protocol on the pipe named for its directory', async (t) => {
    // Arrange: a leader of a published version listens on the pipe of the directory.
    await using scratch = await new TemporaryFiles().directory('mutex-test-');
    const pipe = pipeFor(resolve(scratch.path, directory, 'lock.sock'));

    // Act
    await using follower = await new NodeCommand(
      `
        import { createServer } from 'node:net';
        import { createInterface } from 'node:readline';
        import { Mutex } from ${JSON.stringify(mutexUrl.href)};
        import { SocketStore } from ${JSON.stringify(socketUrl.href)};
        process.chdir(${JSON.stringify(scratch.path)});
        const leader = createServer((peer) => {
          peer.on('error', () => {});
          const lines = createInterface({ input: peer });
          lines.on('error', () => {});
          lines.once('line', (line) => process.send({ type: 'hello', line }));
        });
        leader.listen(${JSON.stringify(pipe)}, () => {
          const store = new SocketStore(${JSON.stringify(directory)}, { clock: globalThis });
          store.on('role', (role) => process.send({ type: 'role', role }));
          void new Mutex(store).acquire('product:42', async () => {});
        });
      `,
      {
        name: 'windows-follower',
        env: process.env,
        clock: globalThis,
        nodeOptions: asOnWindows,
      },
    ).start({ signal: t.signal });
    // A hello, a role or an exit; the assertion below says which.
    await Promise.race([
      follower.next(({ type }) => type === 'hello' || type === 'role', {
        signal: t.signal,
      }),
      follower.process.ended,
    ]);

    // Assert
    assert.match(
      String(
        follower.messages.find((message) => message.type === 'hello')?.line,
      ),
      helloLine,
      `Messages: ${JSON.stringify(follower.messages)} ${follower.process.stderrTail()}`,
    );
  });

  test('a store that leads listens on the pipe named for its directory', async (t) => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('mutex-test-');
    const pipe = pipeFor(resolve(scratch.path, directory, 'lock.sock'));

    // Act: the store leads, and a follower of a published version says hello on the pipe.
    await using leader = await new NodeCommand(
      `
        import { connect } from 'node:net';
        import { Mutex } from ${JSON.stringify(mutexUrl.href)};
        import { SocketStore } from ${JSON.stringify(socketUrl.href)};
        process.chdir(${JSON.stringify(scratch.path)});
        const store = new SocketStore(${JSON.stringify(directory)}, { clock: globalThis });
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
        follower.write('{"op":"hello","version":3,"session":"d3b07384-d9a0-4c9b-8f6e-1a2b3c4d5e6f"}\\n');
      `,
      {
        name: 'windows-leader',
        env: process.env,
        clock: globalThis,
        nodeOptions: asOnWindows,
      },
    ).start({ signal: t.signal });
    // An answer, a failure or an exit; the assertions below say which.
    await Promise.race([
      leader.next(({ type }) => type === 'answer' || type === 'failed', {
        signal: t.signal,
      }),
      leader.process.ended,
    ]);

    // Assert
    assert.equal(
      leader.messages.find((message) => message.type === 'role')?.role,
      'leader',
    );
    assert.equal(
      leader.messages.find((message) => message.type === 'answer')?.received,
      '{"op":"welcome"}\n',
      `Messages: ${JSON.stringify(leader.messages)} ${leader.process.stderrTail()}`,
    );
  });
});
