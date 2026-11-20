import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { type Socket, connect, createServer } from 'node:net';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { untilAborted } from '@zukhruf/async';
import { TemporaryFiles } from '@zukhruf/fs';

import { ConnectionClosedError } from './connection-closed-error.ts';
import { SocketConnection } from './socket-connection.ts';

describe('Socket connection', () => {
  test('a peer that dies while this side writes is reported as closed, not thrown', async (t) => {
    // Arrange: a connection whose peer accepts and then destroys its end at once.
    await using directory = await new TemporaryFiles().directory('flights-');
    const socketPath =
      process.platform === 'win32'
        ? `\\\\.\\pipe\\single-flight-test-${randomUUID()}`
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
    connection.once('close', () => (closed = true));
    const closing = once(connection, 'close');

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
      await untilAborted(closing, t.signal);
      assert.equal(closed, true);
    } finally {
      socket.destroy();
      server.close();
    }
  });
});
