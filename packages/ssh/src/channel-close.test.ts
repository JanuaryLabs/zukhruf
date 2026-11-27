import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';
import ssh2 from 'ssh2';

import { Client, OpenChannelError } from './index.ts';

test('a stream of dial that is destroyed while the server still writes sends no CHANNEL_WINDOW_ADJUST after its CHANNEL_CLOSE, which a server on golang.org/x/crypto/ssh answers with the end of the connection', async () => {
  // Arrange
  // An ssh2 server, whose debug output shows each message that comes to
  // it, after a timestamp. OpenSSH and ssh2 ignore an adjust of a closed
  // channel, so only the wire shows the defect.
  const inbound: string[] = [];
  const closed = Promise.withResolvers<void>();
  const ended = Promise.withResolvers<void>();
  const server = new ssh2.Server(
    {
      hostKeys: [ssh2.utils.generateKeyPairSync('ed25519').private],
      debug: (line) => {
        const message = /Inbound: (CHANNEL_\w+)/.exec(line)?.[1];
        if (message === undefined) return;
        inbound.push(message);
        if (message === 'CHANNEL_CLOSE') closed.resolve();
      },
    },
    (connection) => {
      connection.once('close', () => ended.resolve());
      connection.on('authentication', (context) => context.accept());
      let opened = 0;
      connection.on('tcpip', (accept, reject) => {
        opened += 1;
        if (opened > 1) {
          reject();
          return;
        }
        // Four windows of the client, so that the data that comes after
        // the close of the client fills its window past the threshold of
        // an adjust (1 MiB of 2 MiB, ssh2 1.17.0 Channel.js:15-16).
        accept().write(Buffer.alloc(8 * 1024 * 1024));
      });
    },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object');
    await using client = await Client.dial(`127.0.0.1:${address.port}`, {
      user: 'test',
      auth: [{ type: 'password', password: 'test' }],
      hostKey: () => undefined,
      clock: createClock(),
    });
    const stream = await client.dial('tcp', '127.0.0.1:1');

    // Act
    // The break destroys the stream after the first chunk, as a reader
    // that stops following a log does.
    for await (const _chunk of stream) break;
    await closed.promise;
    // The refusal of a second dial comes after the CHANNEL_CLOSE of the
    // server, at which ssh2 sends no more adjusts (utils.js:64-65), so each
    // adjust is on the wire before the DISCONNECT of the close.
    await assert.rejects(client.dial('tcp', '127.0.0.1:1'), OpenChannelError);
    await client.close();
    await ended.promise;

    // Assert
    // The CHANNEL_OPEN is the second dial.
    assert.deepEqual(inbound.slice(inbound.indexOf('CHANNEL_CLOSE')), [
      'CHANNEL_CLOSE',
      'CHANNEL_OPEN',
    ]);
  } finally {
    server.close();
  }
});
