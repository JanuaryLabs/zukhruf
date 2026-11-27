import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type Socket, connect, createServer } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { Latch, untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';
import { ConnectionClosedError } from '@zukhruf/rpc';

import { SocketConnection } from './socket-connection.ts';

describe('Socket connection', () => {
  test('a peer that dies while this side writes is reported as closed, not thrown', async (t) => {
    // Arrange: a connection whose peer accepts and then destroys its end at once.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\mutex-test-${randomUUID()}`
        : join(directory.path, 'peer.sock');
    const peers: Socket[] = [];
    const server = createServer((peer) => {
      peers.push(peer);
      peer.destroy();
    });
    server.listen(socketPath);
    await once(server, 'listening');
    const socket = connect(socketPath);
    await once(socket, 'connect');
    const connection = new SocketConnection<{ n: number }>(socket);
    let closed = false;
    const closing = new Latch();
    connection.once('close', () => {
      closed = true;
      closing.open();
    });

    try {
      // Act: keep writing until the dead peer makes a write fail.
      for (let n = 0; n < 1000 && !closed; n++) {
        try {
          await connection.send({ n });
        } catch (error) {
          if (!(error instanceof ConnectionClosedError)) throw error;
        }
      }

      // Assert: the loss arrives as `close`, and the process did not crash.
      // The connection must report the dead peer as closed.
      await untilAborted(closing.wait(), t.signal);
      assert.equal(closed, true);
    } finally {
      socket.destroy();
      server.close();
    }
  });

  test('a line that is not JSON closes the connection, and a send after it fails with ConnectionClosedError', async (t) => {
    // Arrange: a connection whose peer the test writes for.
    await using directory = await new TemporaryFiles().directory('mutex-test-');
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\mutex-test-${randomUUID()}`
        : join(directory.path, 'peer.sock');
    const accepted = Promise.withResolvers<Socket>();
    const server = createServer((peer) => accepted.resolve(peer));
    server.listen(socketPath);
    await once(server, 'listening');
    const socket = connect(socketPath);
    await once(socket, 'connect');
    const connection = new SocketConnection<{ n: number }>(socket);
    const closing = new Latch();
    connection.once('close', () => closing.open());
    // Listens after the connection's own reader, so a newline seen here was read by the connection first.
    let received = '';
    const lineRead = Promise.withResolvers<void>();
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString();
      if (received.includes('\n')) lineRead.resolve();
    });
    const peer = await untilAborted(accepted.promise, t.signal);

    try {
      // Act
      peer.write('not json\n');
      await untilAborted(lineRead.promise, t.signal);

      // Assert
      await assert.rejects(connection.send({ n: 1 }), ConnectionClosedError);
      // The connection must report that it closed.
      await untilAborted(closing.wait(), t.signal);
    } finally {
      peer.destroy();
      socket.destroy();
      server.close();
    }
  });
});
