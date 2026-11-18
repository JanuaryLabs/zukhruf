import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { duplexPair } from 'node:stream';
import { test } from 'node:test';
import { setImmediate as nextMacrotask } from 'node:timers/promises';

import { createClock } from '@sinonjs/fake-timers';

import { Client, PrivateKey, ServerConn } from './index.ts';

const interval = 1000;

/**
 * A client logged in to our server over an in-memory wire, with a keepalive
 * on a fake clock. The wire counts the packets that the client sends after
 * the login: ssh2 writes a packet in one to four writes, all in one turn of
 * the event loop (lib/protocol/crypto.js of ssh2 1.17.0), so the writes of one
 * turn are one packet. With `holdAnswers`, the wire holds each chunk that the
 * server sends after the login until deliverHeld(): the server stops
 * answering.
 */
async function connect(options: {
  readonly countMax: number;
  readonly holdAnswers: boolean;
}): Promise<
  AsyncDisposable & {
    readonly client: Client;
    readonly server: ServerConn;
    readonly clock: ReturnType<typeof createClock>;
    sent(): number;
    deliverHeld(): void;
  }
> {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'sec1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const [clientEnd, clientWire] = duplexPair();
  const [serverWire, serverEnd] = duplexPair();
  const held: Buffer[] = [];
  const wire = { loggedIn: false, sent: 0, inPacket: false };
  clientWire.on('data', (chunk: Buffer) => {
    if (wire.loggedIn && !wire.inPacket) {
      wire.sent += 1;
      wire.inPacket = true;
      setImmediate(() => (wire.inPacket = false));
    }
    serverWire.write(chunk);
  });
  serverWire.on('data', (chunk: Buffer) => {
    if (wire.loggedIn && options.holdAnswers) held.push(chunk);
    else clientWire.write(chunk);
  });
  clientWire.on('end', () => serverWire.end());
  serverWire.on('end', () => clientWire.end());
  const clock = createClock();
  const [conn, client] = await Promise.all([
    ServerConn.handshake(serverEnd, {
      hostKeys: [PrivateKey.parse(Buffer.from(privateKey))],
      password: () => true,
    }),
    Client.handshake(clientEnd, 'box.example.com:22', {
      user: 'test',
      auth: [{ type: 'password', password: 'secret' }],
      hostKey: () => undefined,
      clock,
      keepalive: { interval, countMax: options.countMax },
    }),
  ]);
  wire.loggedIn = true;
  return {
    client,
    server: conn,
    clock,
    sent: () => wire.sent,
    deliverHeld() {
      for (const chunk of held.splice(0)) clientWire.write(chunk);
    },
    async [Symbol.asyncDispose]() {
      await client.close();
      serverEnd.destroy();
      await conn.close();
    },
  };
}

/** Moves the clock, then lets the packets of the wire arrive. */
async function advance(
  clock: ReturnType<typeof createClock>,
  ms: number,
): Promise<void> {
  await clock.tickAsync(ms);
  await nextMacrotask();
}

test('a server that answers no keepalive ends the connection at the check after countMax checks, and wait() rejects with the keepalive error', async () => {
  // Arrange
  await using connection = await connect({ countMax: 2, holdAnswers: true });
  const { client, clock } = connection;
  let settled = false;
  client.wait().then(
    () => (settled = true),
    () => (settled = true),
  );

  // Act
  await advance(clock, 3 * interval - 1);
  const settledBefore = settled;
  const sentBefore = connection.sent();
  await advance(clock, 1);

  // Assert
  assert.equal(settledBefore, false);
  assert.equal(sentBefore, 2);
  await assert.rejects(client.wait(), /keepalive/i);
  assert.equal(connection.sent(), 2);
});

test('the client sends a keepalive request after an interval with no data from the server, and not before', async () => {
  // Arrange
  await using connection = await connect({ countMax: 3, holdAnswers: false });

  // Act
  await advance(connection.clock, interval - 1);
  const sentBefore = connection.sent();
  await advance(connection.clock, 1);

  // Assert
  assert.equal(sentBefore, 0);
  assert.equal(connection.sent(), 1);
});

test('data from the server postpones the next keepalive request by an interval from its arrival', async () => {
  // Arrange
  await using connection = await connect({ countMax: 3, holdAnswers: true });
  const { clock } = connection;
  await advance(clock, interval);

  // Act
  await advance(clock, interval / 2);
  connection.deliverHeld();
  await advance(clock, interval / 2);
  const sentAtSecondInterval = connection.sent();
  await advance(clock, interval / 2);

  // Assert
  assert.equal(sentAtSecondInterval, 1);
  assert.equal(connection.sent(), 2);
});

test('an answer from the server resets the count of checks with no answer', async () => {
  // Arrange
  await using connection = await connect({ countMax: 1, holdAnswers: true });
  const { client, clock } = connection;
  let settled = false;
  client.wait().then(
    () => (settled = true),
    () => (settled = true),
  );
  await advance(clock, interval);
  await advance(clock, interval / 2);

  // Act
  connection.deliverHeld();
  await advance(clock, interval);
  const settledAfterAnswer = settled;
  const sentAfterAnswer = connection.sent();
  await advance(clock, interval);

  // Assert
  assert.equal(settledAfterAnswer, false);
  assert.equal(sentAfterAnswer, 2);
  await assert.rejects(client.wait(), /keepalive/i);
});

test('close() stops the keepalive at once: no timer of the client stays on its clock from the call', async () => {
  // Arrange
  await using connection = await connect({ countMax: 3, holdAnswers: false });
  const { client, clock } = connection;
  const timersBeforeClose = clock.countTimers();

  // Act
  const closing = client.close();
  const timersAtClose = clock.countTimers();
  await closing;

  // Assert
  assert.equal(timersBeforeClose, 1);
  assert.equal(timersAtClose, 0);
});

test('the end of the connection stops the keepalive: no timer of the client stays on its clock', async () => {
  // Arrange
  await using connection = await connect({ countMax: 3, holdAnswers: false });
  const { client, clock } = connection;
  const timersBeforeEnd = clock.countTimers();

  // Act
  await connection.server.close();

  // Assert
  await assert.rejects(client.wait(), /closed the connection/);
  assert.equal(timersBeforeEnd, 1);
  assert.equal(clock.countTimers(), 0);
});

test('the answer to a keepalive request answers no later global request of the client: a listen that the server accepts resolves', async () => {
  // Arrange
  await using connection = await connect({ countMax: 3, holdAnswers: true });
  const { client, clock, server } = connection;
  await advance(clock, interval);
  const accepted = (async () => {
    for await (const request of server.requests()) {
      request.accept();
      return;
    }
  })();

  // Act
  const listening = client.listen('tcp', '127.0.0.1:8080', () => undefined);
  await accepted;
  await nextMacrotask();
  connection.deliverHeld();

  // Assert
  const listener = await listening;
  assert.equal(listener.address, '127.0.0.1:8080');
});

test('the keepalive end closes the transport: a session that waits for the server rejects instead of hanging', async () => {
  // Arrange
  await using connection = await connect({ countMax: 1, holdAnswers: true });
  const { client, clock } = connection;
  const outcome = client
    .newSession()
    .run('true')
    .then(
      () => 'ran',
      (error: unknown) => error,
    );

  // Act
  await advance(clock, 2 * interval);

  // Assert
  await assert.rejects(client.wait(), /keepalive/i);
  assert.ok(Error.isError(await outcome));
});
