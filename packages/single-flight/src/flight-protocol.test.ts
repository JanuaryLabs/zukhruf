import assert from 'node:assert/strict';
import { once } from 'node:events';
import { type Socket, connect, createServer } from 'node:net';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';

import { ProtocolVersionError, SingleFlight } from './index.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';
import { waitUntil } from './testing/wait-until.ts';

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
  socket.on('data', (chunk: string) => (received += chunk));
  socket.once('close', () => (closed = true));
  await once(socket, 'connect');
  return {
    send: (line: string) => socket.write(`${line}\n`),
    get received() {
      return received;
    },
    get closed() {
      return closed;
    },
    [Symbol.dispose]: () => socket.destroy(),
  };
}

/** Waits until `peer` got `count` lines. */
function linesOf(
  t: TestContext,
  peer: { readonly received: string },
  count: number,
) {
  return waitUntil(
    t,
    () => peer.received.split('\n').length - 1 >= count,
    () => `Got ${JSON.stringify(peer.received)}`,
  );
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
        createInterface({ input: peer }).once('line', (line) => {
          hellos.push(line);
          peer.end('{"op":"refused","protocol":"single-flight","version":2}\n');
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
      await waitUntil(t, () => peer.closed, 'The coordinator must hang up');
      assert.equal(
        peer.received,
        '{"op":"refused","protocol":"single-flight","version":1}\n',
      );
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
});
