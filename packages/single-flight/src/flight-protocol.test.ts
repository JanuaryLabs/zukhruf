import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { type Socket, connect, createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { FileLock } from '@zukhruf/fs';

import { ProtocolVersionError, SingleFlight } from './index.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';

// Processes of different versions of this package meet on the wire, so these
// tests speak it byte by byte, as such a process would.

const onUnixSockets = {
  skip:
    process.platform === 'win32'
      ? 'A single flight on Windows meets its coordinator on a named pipe'
      : false,
};

const asText = {
  encode: (value: string) => value,
  decode: (text: string) => text,
};

/** A coordinator of this source, serving `directory`. */
async function coordinatorOf(directory: string) {
  const flights = new SingleFlight({ directory, codec: asText });
  await flights.run('warm-up', async () => 'warm');
  return flights;
}

/** A process of another version on `<directory>/flight.sock`: it sends lines and keeps every byte it gets back. */
async function peerOf(directory: string) {
  const socket = connect(join(directory, 'flight.sock'));
  socket.on('error', () => {});
  let received = '';
  let closed = false;
  socket.setEncoding('utf8');
  const readers = new Set<() => void>();
  socket.on('data', (chunk: string) => {
    received += chunk;
    for (const read of readers) read();
  });
  socket.once('close', () => (closed = true));
  await once(socket, 'connect');
  return {
    send: (line: string) => socket.write(`${line}\n`),
    /** Resolves in the step that reads what makes `done` hold, so the caller acts before any timer of this process runs. */
    until(done: () => boolean) {
      const { promise, resolve } = Promise.withResolvers<void>();
      const read = () => {
        if (!done()) return;
        readers.delete(read);
        resolve();
      };
      readers.add(read);
      read();
      return promise;
    },
    get received() {
      return received;
    },
    get closed() {
      return closed;
    },
    [Symbol.dispose]: () => socket.destroy(),
  };
}

const settle = <T>(running: Promise<T>) =>
  running.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

/** Waits until `peer` got `count` lines. */
function linesOf(
  t: TestContext,
  peer: { readonly received: string },
  count: number,
) {
  return t.waitFor(
    () =>
      assert.ok(
        peer.received.split('\n').length - 1 >= count,
        `Got ${JSON.stringify(peer.received)}`,
      ),
    { interval: 5, timeout: 2000 },
  );
}

/** A welcomed process of another version on `<directory>/flight.sock`. */
async function welcomedPeerOf(t: TestContext, directory: string) {
  const peer = await peerOf(directory);
  peer.send('{"op":"hello","protocol":"single-flight","version":1}');
  await linesOf(t, peer, 1);
  return peer;
}

/** The lines `peer` got for its request `id`, in order. */
function answersTo(peer: { readonly received: string }, id: string) {
  return peer.received
    .split('\n')
    .filter((line) => line.includes(`"id":${JSON.stringify(id)}`));
}

/** Waits until `peer` got an answer to `id` that matches `pattern`, and returns it. */
async function answerOf(
  t: TestContext,
  peer: { readonly received: string },
  id: string,
  pattern: RegExp,
) {
  const find = () => answersTo(peer, id).find((line) => pattern.test(line));
  await t.waitFor(
    () =>
      assert.ok(
        find() !== undefined,
        `No ${pattern} for ${id}; got ${JSON.stringify(peer.received)}`,
      ),
    { interval: 5, timeout: 2000 },
  );
  const answer = find();
  assert.ok(answer);
  return answer;
}

/** The token of a `lead` answer. */
function tokenIn(lead: string) {
  const token = /"token":"(\d+)"/.exec(lead)?.[1];
  assert.ok(token, `No token in ${lead}`);
  return BigInt(token);
}

/** Where a process of this protocol holds the kernel lock of `key` while it runs the key's work. */
function keyLockPath(directory: string, key: string) {
  const digest = createHash('sha256').update(key).digest('hex');
  return join(directory, 'execution-locks', `${digest}.lock`);
}

/** Holds the lock of `key`, as a leader process of this protocol does from before its work starts until its landing is acknowledged. */
function holdKey(directory: string, key: string) {
  mkdirSync(join(directory, 'execution-locks'), { recursive: true });
  const lock = FileLock.open(keyLockPath(directory, key));
  assert.ok(lock.tryLock(), `The lock of ${key} is held already`);
  return lock;
}

describe('The wire of a single flight', () => {
  test(
    'a call whose coordinator speaks another protocol version fails with ProtocolVersionError, after a hello that names the protocol',
    { ...onUnixSockets, timeout: 10_000 },
    async () => {
      // Arrange: a coordinator of version 2 holds the term and refuses every hello.
      await using directory = await scratchDirectory();
      const claim = new DatabaseSync(join(directory.path, 'flight.lock'), {
        timeout: 0,
      });
      claim.exec('BEGIN EXCLUSIVE');
      const hellos: string[] = [];
      const peers = new Set<Socket>();
      const server = createServer((peer) => {
        peers.add(peer);
        peer.on('error', () => {});
        // readline emits the socket's errors again, e.g. a reset on Linux when the client closes with unread data.
        createInterface({ input: peer })
          .on('error', () => {})
          .once('line', (line) => {
            hellos.push(line);
            peer.end(
              '{"op":"refused","protocol":"single-flight","version":2}\n',
            );
          });
      });
      server.listen(join(directory.path, 'flight.sock'));
      await once(server, 'listening');
      try {
        await using flights = new SingleFlight({
          directory: directory.path,
          codec: asText,
        });

        // Act
        const result = await flights
          .run('sync', async () => 'never')
          .then(
            () => 'ran',
            (error: unknown) => error,
          );

        // Assert
        assert.ok(result instanceof ProtocolVersionError, String(result));
        assert.equal(result.theirs, 2);
        assert.equal(result.ours, 1);
        assert.deepEqual(hellos, [
          '{"op":"hello","protocol":"single-flight","version":1}',
        ]);
      } finally {
        for (const peer of peers) peer.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        claim.exec('ROLLBACK');
        claim.close();
      }
    },
  );

  test(
    'a single flight does not coordinate while another process holds the claim on flight.lock, and coordinates once it is released',
    { ...onUnixSockets, timeout: 10_000 },
    async () => {
      // Arrange: a coordinator of a published version holds the term and serves nothing yet.
      await using directory = await scratchDirectory();
      const claim = new DatabaseSync(join(directory.path, 'flight.lock'), {
        timeout: 0,
      });
      claim.exec('BEGIN EXCLUSIVE');
      try {
        await using flights = new SingleFlight({
          directory: directory.path,
          codec: asText,
        });
        let runs = 0;
        const work = async () => {
          runs++;
          return 'ran';
        };
        const signal = AbortSignal.timeout(300);

        // Act
        const whileHeld = await settle(flights.run('sync', work, { signal }));
        const runsWhileHeld = runs;
        claim.exec('ROLLBACK');
        claim.close();
        const afterRelease = await settle(flights.run('sync', work));

        // Assert
        assert.deepEqual(whileHeld, { error: signal.reason });
        assert.equal(runsWhileHeld, 0, 'The work ran beside the held term');
        assert.deepEqual(afterRelease, {
          value: { value: 'ran', joined: false },
        });
      } finally {
        if (claim.isOpen) {
          claim.exec('ROLLBACK');
          claim.close();
        }
      }
    },
  );

  test(
    'a coordinator holds the claim on flight.lock, so a candidate of a published version cannot take it',
    { ...onUnixSockets, timeout: 10_000 },
    async () => {
      // Arrange
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(directory.path);
      const candidate = new DatabaseSync(join(directory.path, 'flight.lock'), {
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
          `A published candidate did not lose to the coordinator: ${String(campaign)}`,
        );
      } finally {
        if (candidate.isTransaction) candidate.exec('ROLLBACK');
        candidate.close();
      }
    },
  );

  test(
    'a coordinator after the term in flight.epoch takes the next epoch, records it as decimal text, and leads with tokens of it',
    { ...onUnixSockets, timeout: 10_000 },
    async () => {
      // Arrange: the last coordinator in this directory, of a published version, recorded term 41, which reads differently in hex.
      await using directory = await scratchDirectory();
      await writeFile(join(directory.path, 'flight.epoch'), '41');
      await using flights = new SingleFlight({
        directory: directory.path,
        codec: asText,
      });
      const tokens: bigint[] = [];

      // Act
      await flights.run('sync', async ({ token }) => {
        tokens.push(token.value);
        return 'done';
      });

      // Assert: the epoch is the high 32 bits of every token of the term.
      assert.deepEqual(
        tokens.map((token) => token >> 32n),
        [42n],
      );
      assert.equal(
        await readFile(join(directory.path, 'flight.epoch'), 'utf8'),
        '42',
      );
    },
  );

  test(
    'a coordinator refuses a hello that does not name this protocol, as a socket lock store sends it, and hangs up',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(directory.path);
      using peer = await peerOf(directory.path);

      // Act
      peer.send('{"op":"hello","version":1}');

      // Assert
      await t.waitFor(
        () => assert.ok(peer.closed, 'The coordinator must hang up'),
        { interval: 5, timeout: 2000 },
      );
      assert.equal(
        peer.received,
        '{"op":"refused","protocol":"single-flight","version":1}\n',
      );
    },
  );

  test(
    'a coordinator hangs up without an answer on a process whose first line is not a hello',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(directory.path);
      using peer = await peerOf(directory.path);

      // Act: the process opens with a request, as no single flight does.
      peer.send('{"op":"run","id":"a","key":"sync"}');

      // Assert
      await t.waitFor(
        () => assert.ok(peer.closed, 'The coordinator must hang up'),
        { interval: 5, timeout: 2000 },
      );
      assert.equal(peer.received, '');
    },
  );

  test(
    'a rejoin joins only the flight whose token it names: another flight of the key, or none, answers interrupted',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange: a flight of `sync` is in progress, and `free` has none.
      await using directory = await scratchDirectory();
      await using coordinator = await coordinatorOf(directory.path);
      const leading = Promise.withResolvers<string>();
      const ending = Promise.withResolvers<string>();
      const leader = coordinator.run('sync', async ({ token }) => {
        leading.resolve(token.toString());
        return ending.promise;
      });
      const token = await leading.promise;
      using peer = await peerOf(directory.path);
      peer.send('{"op":"hello","protocol":"single-flight","version":1}');
      await linesOf(t, peer, 1);

      try {
        // Act: joiners of earlier flights come back, as after a lost connection.
        peer.send(
          `{"op":"run","id":"a","key":"sync","flight":"${BigInt(token) - 1n}"}`,
        );
        peer.send(`{"op":"run","id":"b","key":"free","flight":"${token}"}`);
        peer.send(`{"op":"run","id":"c","key":"sync","flight":"${token}"}`);
        await linesOf(t, peer, 4);

        // Assert
        assert.deepEqual(peer.received.split('\n').slice(1, 4), [
          '{"op":"interrupted","id":"a"}',
          '{"op":"interrupted","id":"b"}',
          `{"op":"joined","id":"c","flight":"${token}"}`,
        ]);
      } finally {
        ending.resolve('done');
        await leader;
      }
    },
  );

  test(
    'a rejoin after a reasserted flight ended gets the outcome only of its own ended flight: a rejoin that names another flight of the key is told interrupted',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange: the last coordinator, of a published version, recorded term 41.
      await using directory = await scratchDirectory();
      await writeFile(join(directory.path, 'flight.epoch'), '41');
      await using flights = new SingleFlight({
        directory: directory.path,
        codec: asText,
      });
      // This run starts the coordinator.
      const warmUp = settle(flights.run('warm-up', async () => 'warm'));
      await t.waitFor(
        () =>
          assert.ok(
            existsSync(join(directory.path, 'flight.sock')),
            'The coordinator must listen',
          ),
        { interval: 5, timeout: 2000 },
      );
      using peer = await peerOf(directory.path);
      peer.send('{"op":"hello","protocol":"single-flight","version":1}');
      await linesOf(t, peer, 1);
      // A leader of term 41 reasserts its flight of `sync` and lands it.
      const ended = (41n << 32n) | 1n;
      peer.send(`{"op":"reassert","id":"a","key":"sync","token":"${ended}"}`);
      peer.send('{"op":"land","id":"a","outcome":{"value":"first"}}');
      await linesOf(t, peer, 2);

      // Act: a joiner of another flight of `sync` comes back, and then a joiner of the ended flight.
      peer.send(`{"op":"run","id":"b","key":"sync","flight":"${ended + 1n}"}`);
      peer.send(`{"op":"run","id":"c","key":"sync","flight":"${ended}"}`);
      await linesOf(t, peer, 4);

      // Assert: no process holds the key, so neither rejoin waits.
      assert.deepEqual(peer.received.split('\n').slice(1, 4), [
        '{"op":"ack","id":"a"}',
        '{"op":"interrupted","id":"b"}',
        '{"op":"landed","id":"c","outcome":{"value":"first"}}',
      ]);
      await warmUp;
    },
  );

  test(
    'a run that is withdrawn while the coordinator mints its token never leads, and the next run of the key leads',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(directory.path);
      using peer = await peerOf(directory.path);
      peer.send('{"op":"hello","protocol":"single-flight","version":1}');
      await linesOf(t, peer, 1);

      // Act: the run and its cancel go in one write, so the coordinator reads the cancel before the run's token is minted.
      peer.send('{"op":"run","id":"a","key":"sync"}\n{"op":"cancel","id":"a"}');
      peer.send('{"op":"run","id":"b","key":"sync"}');
      await linesOf(t, peer, 2);

      // Assert
      const answers = peer.received.split('\n').slice(1, -1);
      assert.equal(answers.length, 1, `Got ${JSON.stringify(answers)}`);
      assert.match(
        answers[0] ?? '',
        /^\{"op":"lead","id":"b","token":"\d+"\}$/,
      );
    },
  );

  test(
    'a coordinator answers a run and a rejoin once each, also when each reaches it twice with one id',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange: a flight of `sync` is in progress, and a process is welcomed.
      await using directory = await scratchDirectory();
      await using coordinator = await coordinatorOf(directory.path);
      const leading = Promise.withResolvers<string>();
      const ending = Promise.withResolvers<string>();
      const leader = coordinator.run('sync', async ({ token }) => {
        leading.resolve(token.toString());
        return ending.promise;
      });
      const token = await leading.promise;
      using peer = await peerOf(directory.path);
      peer.send('{"op":"hello","protocol":"single-flight","version":1}');
      await linesOf(t, peer, 1);

      try {
        // Act: each request reaches the coordinator twice, as after a resend; a run of another key comes last, so its answer follows every earlier one.
        peer.send('{"op":"run","id":"a","key":"sync"}');
        peer.send('{"op":"run","id":"a","key":"sync"}');
        peer.send(`{"op":"run","id":"b","key":"sync","flight":"${token}"}`);
        peer.send(`{"op":"run","id":"b","key":"sync","flight":"${token}"}`);
        peer.send('{"op":"run","id":"c","key":"other"}');
        await t.waitFor(
          () =>
            assert.ok(
              /"id":"c".*\n/.test(peer.received),
              `Got ${JSON.stringify(peer.received)}`,
            ),
          { interval: 5, timeout: 2000 },
        );

        // Assert
        const answers = peer.received.split('\n').slice(1, -1);
        const last = answers.pop();
        assert.match(last ?? '', /^\{"op":"lead","id":"c","token":"\d+"\}$/);
        assert.deepEqual(answers.toSorted(), [
          `{"op":"joined","id":"a","flight":"${token}"}`,
          `{"op":"joined","id":"b","flight":"${token}"}`,
        ]);
      } finally {
        ending.resolve('done');
        await leader;
      }
    },
  );

  test(
    'a coordinator answers a request it does not know with unsupported, and keeps serving the connection',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange: a process of a later version is welcomed.
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(directory.path);
      using peer = await peerOf(directory.path);
      peer.send('{"op":"hello","protocol":"single-flight","version":1}');
      await linesOf(t, peer, 1);

      // Act: it asks for something this version does not know, and then runs a flight.
      peer.send('{"op":"look","id":"a","key":"sync"}');
      peer.send('{"op":"run","id":"b","key":"sync"}');
      await linesOf(t, peer, 3);

      // Assert
      const [welcome, unsupported, lead] = peer.received.split('\n');
      assert.equal(welcome, '{"op":"welcome"}');
      assert.equal(unsupported, '{"op":"unsupported","id":"a"}');
      assert.match(lead ?? '', /^\{"op":"lead","id":"b","token":"\d+"\}$/);
      assert.equal(peer.closed, false);
    },
  );

  test(
    'a peer that sends a JSON line that is not a request keeps its flight',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange: a welcomed process leads the flight of `sync`, and the coordinator's own call joins it.
      await using directory = await scratchDirectory();
      await using coordinator = await coordinatorOf(directory.path);
      using peer = await peerOf(directory.path);
      peer.send('{"op":"hello","protocol":"single-flight","version":1}');
      await linesOf(t, peer, 1);
      peer.send('{"op":"run","id":"a","key":"sync"}');
      await linesOf(t, peer, 2);
      const joined = Promise.withResolvers<void>();
      const joiner = settle(
        coordinator.run('sync', async () => 'never', {
          onJoin: joined.resolve,
        }),
      );
      await joined.promise;

      // Act: JSON lines that are not requests (no record, no id, no op, neither), then a run, then the landing.
      peer.send('null');
      peer.send('{"op":"run","key":"other"}');
      peer.send('{"id":"x"}');
      peer.send('{"note":"not a flight request"}');
      peer.send('{"op":"run","id":"b","key":"other"}');
      await linesOf(t, peer, 3);
      peer.send('{"op":"land","id":"a","outcome":{"value":"from the peer"}}');
      const joinerResult = await joiner;

      // Assert: no line got an answer, the run after them did, and the joiner got the peer's outcome.
      await linesOf(t, peer, 4);
      const [welcome, leadA, leadB, ack] = peer.received.split('\n');
      assert.equal(welcome, '{"op":"welcome"}');
      assert.match(leadA ?? '', /^\{"op":"lead","id":"a","token":"\d+"\}$/);
      assert.match(leadB ?? '', /^\{"op":"lead","id":"b","token":"\d+"\}$/);
      assert.equal(ack, '{"op":"ack","id":"a"}');
      assert.deepEqual(joinerResult, {
        value: { value: 'from the peer', joined: true },
      });
      assert.equal(peer.closed, false, 'The connection must stay open');
    },
  );

  test(
    'a coordinator hangs up on a welcomed process that sends a line that is not JSON',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(directory.path);
      using peer = await peerOf(directory.path);
      peer.send('{"op":"hello","protocol":"single-flight","version":1}');
      await linesOf(t, peer, 1);

      // Act
      peer.send('run sync');

      // Assert
      await t.waitFor(
        () => assert.ok(peer.closed, 'The coordinator must hang up'),
        { interval: 5, timeout: 2000 },
      );
      assert.equal(peer.received, '{"op":"welcome"}\n');
    },
  );
});

describe('The wire of a single flight while a process holds a key', () => {
  test(
    'a reassertion and its landing in one write reach a run that waits for the key: it joins, gets the landing, and nobody leads again',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange: a process leads `sync` and holds its key; its connection is
      // lost, so the coordinator ends the flight, and the joiner learns it.
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(directory.path);
      using first = await welcomedPeerOf(t, directory.path);
      first.send('{"op":"run","id":"a","key":"sync"}');
      const token = tokenIn(await answerOf(t, first, 'a', /"op":"lead"/));
      using key = holdKey(directory.path, 'sync');
      using joiner = await welcomedPeerOf(t, directory.path);
      joiner.send('{"op":"run","id":"j","key":"sync"}');
      await answerOf(t, joiner, 'j', /"op":"joined"/);
      first[Symbol.dispose]();
      await answerOf(t, joiner, 'j', /"op":"interrupted"/);
      // A run of another key, sent after the fresh run, is answered after the fresh run was decided.
      using fresh = await welcomedPeerOf(t, directory.path);
      fresh.send('{"op":"run","id":"p","key":"sync"}');
      fresh.send('{"op":"run","id":"q","key":"other"}');
      await answerOf(t, fresh, 'q', /"op":"lead"/);
      const waited = answersTo(fresh, 'p');

      // Act: the leader comes back with its reassertion and its landing in one
      // write, and lets its key go once the landing is acknowledged.
      using back = await welcomedPeerOf(t, directory.path);
      back.send(
        `{"op":"reassert","id":"a","key":"sync","token":"${token}"}\n{"op":"land","id":"a","outcome":{"value":"once"}}`,
      );
      await answerOf(t, back, 'a', /"op":"ack"/);
      key.unlock();
      await answerOf(t, fresh, 'p', /"op":"(landed|lead)"/);

      // Assert
      assert.deepEqual(waited, [], 'The run did not wait for the held key');
      assert.deepEqual(answersTo(fresh, 'p'), [
        `{"op":"joined","id":"p","flight":"${token}"}`,
        '{"op":"landed","id":"p","outcome":{"value":"once"}}',
      ]);
    },
  );

  test(
    'a run of a key whose lock cannot be checked leads, a rejoin of it is told interrupted, and the connection stays open',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange: platform setup that no operation exposes. A folder where the
      // key's lock file belongs makes every check of that lock fail.
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(directory.path);
      await mkdir(keyLockPath(directory.path, 'sync'), { recursive: true });
      using peer = await welcomedPeerOf(t, directory.path);

      // Act: a rejoin of a flight this coordinator never knew, a run, and a run of another key.
      peer.send('{"op":"run","id":"r","key":"sync","flight":"7"}');
      peer.send('{"op":"run","id":"a","key":"sync"}');
      peer.send('{"op":"run","id":"b","key":"other"}');
      await linesOf(t, peer, 4);

      // Assert
      assert.deepEqual(answersTo(peer, 'r'), ['{"op":"interrupted","id":"r"}']);
      assert.match(
        answersTo(peer, 'a').join('\n'),
        /^\{"op":"lead","id":"a","token":"\d+"\}$/,
      );
      assert.match(
        answersTo(peer, 'b').join('\n'),
        /^\{"op":"lead","id":"b","token":"\d+"\}$/,
      );
      assert.equal(peer.closed, false, 'The connection must stay open');
    },
  );

  test(
    'a run that waits for a held key leads once the lock can no longer be checked',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange: a process holds `sync`, and a run waits for it.
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(directory.path);
      using key = holdKey(directory.path, 'sync');
      using peer = await welcomedPeerOf(t, directory.path);
      peer.send('{"op":"run","id":"p","key":"sync"}');
      peer.send('{"op":"run","id":"q","key":"other"}');
      await answerOf(t, peer, 'q', /"op":"lead"/);
      const waited = answersTo(peer, 'p');

      // Act: platform setup that no operation exposes. In one step, the
      // holder lets the key go, and a folder takes the place of the lock file,
      // so no check of the lock sees it free: each check fails.
      key[Symbol.dispose]();
      rmSync(keyLockPath(directory.path, 'sync'));
      mkdirSync(keyLockPath(directory.path, 'sync'));
      const answer = await answerOf(t, peer, 'p', /./);

      // Assert
      assert.deepEqual(waited, [], 'The run did not wait for the held key');
      assert.match(answer, /^\{"op":"lead","id":"p","token":"\d+"\}$/);
      assert.equal(peer.closed, false, 'The connection must stay open');
    },
  );

  test(
    'for two reassertions of one key the newer token wins: the older leader is rejected, its joiner is told interrupted, and an older reassertion after it is rejected',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange: a leader of an earlier term reasserts its flight of `sync`, and a joiner rejoins it.
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(directory.path);
      const older = (1n << 32n) | 100n;
      using first = await welcomedPeerOf(t, directory.path);
      first.send(`{"op":"reassert","id":"a","key":"sync","token":"${older}"}`);
      using joiner = await welcomedPeerOf(t, directory.path);
      joiner.send(`{"op":"run","id":"j","key":"sync","flight":"${older}"}`);
      await answerOf(t, joiner, 'j', /"op":"joined"/);

      // Act: a leader with a newer token of the key reasserts, and then the older one again.
      using second = await welcomedPeerOf(t, directory.path);
      second.send(
        `{"op":"reassert","id":"b","key":"sync","token":"${older + 1n}"}`,
      );
      await answerOf(t, first, 'a', /"op":"rejected"/);
      using third = await welcomedPeerOf(t, directory.path);
      third.send(`{"op":"reassert","id":"c","key":"sync","token":"${older}"}`);
      await answerOf(t, third, 'c', /./);
      second.send('{"op":"land","id":"b","outcome":{"value":"newer"}}');
      await answerOf(t, second, 'b', /./);

      // Assert
      assert.deepEqual(answersTo(first, 'a'), ['{"op":"rejected","id":"a"}']);
      assert.deepEqual(answersTo(joiner, 'j'), [
        `{"op":"joined","id":"j","flight":"${older}"}`,
        '{"op":"interrupted","id":"j"}',
      ]);
      assert.deepEqual(answersTo(third, 'c'), ['{"op":"rejected","id":"c"}']);
      assert.deepEqual(answersTo(second, 'b'), ['{"op":"ack","id":"b"}']);
    },
  );

  test(
    'a rejoin of a flight that was led here and has ended is told interrupted',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange: a flight of `sync` led on this coordinator lands.
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(directory.path);
      using leader = await welcomedPeerOf(t, directory.path);
      leader.send('{"op":"run","id":"a","key":"sync"}');
      const token = tokenIn(await answerOf(t, leader, 'a', /"op":"lead"/));
      leader.send('{"op":"land","id":"a","outcome":{"value":"first"}}');
      await answerOf(t, leader, 'a', /"op":"ack"/);
      using joiner = await welcomedPeerOf(t, directory.path);

      // Act: a joiner whose connection was lost comes back for it.
      joiner.send(`{"op":"run","id":"j","key":"sync","flight":"${token}"}`);
      await answerOf(t, joiner, 'j', /./);

      // Assert: only an ending of a reasserted flight is kept for a late rejoin.
      assert.deepEqual(answersTo(joiner, 'j'), [
        '{"op":"interrupted","id":"j"}',
      ]);
    },
  );

  test(
    'a run withdrawn while it waits for a held key is never answered, also when a flight of the key starts after the withdrawal',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange: a process leads `sync` and holds its key; its connection is
      // lost, so the coordinator ends the flight, and the joiner learns it.
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(directory.path);
      using first = await welcomedPeerOf(t, directory.path);
      first.send('{"op":"run","id":"a","key":"sync"}');
      const token = tokenIn(await answerOf(t, first, 'a', /"op":"lead"/));
      using _key = holdKey(directory.path, 'sync');
      using joiner = await welcomedPeerOf(t, directory.path);
      joiner.send('{"op":"run","id":"j","key":"sync"}');
      await answerOf(t, joiner, 'j', /"op":"joined"/);
      first[Symbol.dispose]();
      await answerOf(t, joiner, 'j', /"op":"interrupted"/);
      // The leader comes back, and two runs of its process wait for the key.
      // A run of another key, sent after them, is answered after both were decided.
      using back = await welcomedPeerOf(t, directory.path);
      back.send('{"op":"run","id":"p","key":"sync"}');
      back.send('{"op":"run","id":"r","key":"sync"}');
      back.send('{"op":"run","id":"q","key":"other"}');
      await answerOf(t, back, 'q', /"op":"lead"/);
      const waited = [...answersTo(back, 'p'), ...answersTo(back, 'r')];

      // Act: `p` is withdrawn, and then the leader reasserts its flight, which
      // takes the runs of the key that wait. The key stays held, so only that
      // flight wakes them. A run of another key, sent last, is answered after both.
      back.send('{"op":"cancel","id":"p"}');
      back.send(`{"op":"reassert","id":"a","key":"sync","token":"${token}"}`);
      back.send('{"op":"run","id":"s","key":"another"}');
      await answerOf(t, back, 's', /"op":"lead"/);

      // Assert: the run that still waited joined the reasserted flight.
      assert.deepEqual(waited, [], 'The runs did not wait for the held key');
      assert.deepEqual(answersTo(back, 'p'), []);
      assert.deepEqual(answersTo(back, 'r'), [
        `{"op":"joined","id":"r","flight":"${token}"}`,
      ]);
    },
  );

  test(
    'a run withdrawn while it waits for a held key is never answered, and a run that waits with it leads once the key is free',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange: a process holds `sync`, and two runs wait for it. A run of
      // another key, sent after them, is answered after both were decided.
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(directory.path);
      using key = holdKey(directory.path, 'sync');
      using peer = await welcomedPeerOf(t, directory.path);
      peer.send('{"op":"run","id":"p","key":"sync"}');
      peer.send('{"op":"run","id":"r","key":"sync"}');
      peer.send('{"op":"run","id":"q","key":"other"}');
      await answerOf(t, peer, 'q', /"op":"lead"/);
      const waited = [...answersTo(peer, 'p'), ...answersTo(peer, 'r')];

      // Act: `p` is withdrawn, and the key goes only once the coordinator read
      // that: the lead of a run sent right behind the cancel shows it. The
      // protocol does not order a cancel against a free key that the watch of
      // the key sees first; then `p` leads, and its cancel interrupts that
      // flight. A run of another key, sent last, is answered after `r`.
      peer.send('{"op":"cancel","id":"p"}');
      peer.send('{"op":"run","id":"c","key":"cancelled"}');
      await answerOf(t, peer, 'c', /"op":"lead"/);
      key.unlock();
      await answerOf(t, peer, 'r', /./);
      peer.send('{"op":"run","id":"s","key":"another"}');
      await answerOf(t, peer, 's', /"op":"lead"/);

      // Assert
      assert.deepEqual(waited, [], 'The runs did not wait for the held key');
      assert.deepEqual(answersTo(peer, 'p'), []);
      assert.match(
        answersTo(peer, 'r').join('\n'),
        /^\{"op":"lead","id":"r","token":"\d+"\}$/,
      );
    },
  );

  test(
    'a leader that reasserts its own token on a new connection keeps its flight: the close of its first connection interrupts nothing, and the joiner gets the landing',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange: a process leads `sync` and `other` on its first connection, and the joiner joins both.
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(directory.path);
      using first = await welcomedPeerOf(t, directory.path);
      first.send('{"op":"run","id":"a","key":"sync"}');
      first.send('{"op":"run","id":"o","key":"other"}');
      const token = tokenIn(await answerOf(t, first, 'a', /"op":"lead"/));
      await answerOf(t, first, 'o', /"op":"lead"/);
      using joiner = await welcomedPeerOf(t, directory.path);
      joiner.send('{"op":"run","id":"j","key":"sync"}');
      joiner.send('{"op":"run","id":"k","key":"other"}');
      await answerOf(t, joiner, 'k', /"op":"joined"/);

      // Act: the flight of `sync` goes on through a second connection; the
      // first one closes, which ends `other`, which was not reasserted.
      using second = await welcomedPeerOf(t, directory.path);
      second.send(`{"op":"reassert","id":"a","key":"sync","token":"${token}"}`);
      second.send('{"op":"run","id":"after","key":"after"}');
      await answerOf(t, second, 'after', /"op":"lead"/);
      first[Symbol.dispose]();
      await answerOf(t, joiner, 'k', /"op":"interrupted"/);
      second.send('{"op":"land","id":"a","outcome":{"value":"kept"}}');
      await answerOf(t, joiner, 'j', /"op":"(landed|interrupted)"/);

      // Assert
      assert.deepEqual(answersTo(joiner, 'j'), [
        `{"op":"joined","id":"j","flight":"${token}"}`,
        '{"op":"landed","id":"j","outcome":{"value":"kept"}}',
      ]);
      assert.deepEqual(answersTo(second, 'a'), ['{"op":"ack","id":"a"}']);
    },
  );

  test(
    'a run that waits for a held key and a run that comes once the key is free share one flight, whose token is newer than the flight before it',
    { ...onUnixSockets, timeout: 10_000 },
    async (t) => {
      // Arrange
      await using directory = await scratchDirectory();
      await using _coordinator = await coordinatorOf(directory.path);
      using first = await welcomedPeerOf(t, directory.path);
      using waiter = await welcomedPeerOf(t, directory.path);
      using late = await welcomedPeerOf(t, directory.path);
      const isLead = (line: string) => line.includes('"op":"lead"');
      const rounds = [];

      // Which run leads depends on whether the key's lock watch sees the key
      // free before the late run comes. Only when the late run leads first
      // must its flight take the waiting run, so the late run comes in the
      // step that reads the waiting run's barrier, and each key is one more
      // chance.
      for (const key of ['k1', 'k2', 'k3', 'k4']) {
        // Arrange: a process led the key and landed it, and still holds the
        // key, as a leader does until it reads the acknowledgement; a run
        // waits for it, and a run of another key, sent after it, leads.
        const [a, p, q, x] = [`a-${key}`, `p-${key}`, `q-${key}`, `x-${key}`];
        first.send(`{"op":"run","id":"${a}","key":"${key}"}`);
        const before = tokenIn(await answerOf(t, first, a, /"op":"lead"/));
        using held = holdKey(directory.path, key);
        first.send(`{"op":"land","id":"${a}","outcome":{"value":"first"}}`);
        await answerOf(t, first, a, /"op":"ack"/);
        waiter.send(`{"op":"run","id":"${p}","key":"${key}"}`);
        waiter.send(`{"op":"run","id":"${q}","key":"other-${key}"}`);
        // The watch of the key checked its lock when the run waited, just
        // before this answer, so its next check is a poll interval away.
        await waiter.until(() => answersTo(waiter, q).some(isLead));
        const waited = answersTo(waiter, p);

        // Act: the key goes, and another run comes at once. Whichever leads
        // takes the key, as a leader does, lands, and lets the key go.
        held.unlock();
        late.send(`{"op":"run","id":"${x}","key":"${key}"}`);
        await t.waitFor(
          () =>
            assert.ok(
              answersTo(waiter, p).some(isLead) ||
                answersTo(late, x).some(isLead),
              `Nobody leads: ${JSON.stringify(waiter.received)} ${JSON.stringify(late.received)}`,
            ),
          { interval: 5, timeout: 2000 },
        );
        const [leader, id, joiner, joinerId] = answersTo(waiter, p).some(isLead)
          ? [waiter, p, late, x]
          : [late, x, waiter, p];
        const token = tokenIn(answersTo(leader, id).find(isLead) ?? '');
        using retaken = holdKey(directory.path, key);
        leader.send(`{"op":"land","id":"${id}","outcome":{"value":"second"}}`);
        await answerOf(t, leader, id, /"op":"ack"/);
        retaken.unlock();
        await answerOf(t, joiner, joinerId, /"op":"(landed|lead)"/);
        rounds.push({
          key,
          waited,
          before,
          token,
          joined: answersTo(joiner, joinerId),
          expected: [
            `{"op":"joined","id":"${joinerId}","flight":"${token}"}`,
            `{"op":"landed","id":"${joinerId}","outcome":{"value":"second"}}`,
          ],
        });
      }

      // Assert
      for (const { key, waited, before, token, joined, expected } of rounds) {
        assert.deepEqual(
          waited,
          [],
          `The run of ${key} did not wait for the held key`,
        );
        assert.deepEqual(
          joined,
          expected,
          `The runs of ${key} did not share one flight`,
        );
        assert.ok(
          token > before,
          `The flight ${token} of ${key} has a token not newer than the flight ${before} before it`,
        );
      }
    },
  );
});
