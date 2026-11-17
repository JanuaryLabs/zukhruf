import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { type Server, type Socket, connect, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { type Duplex, finished } from 'node:stream';
import { text } from 'node:stream/consumers';
import { pipeline } from 'node:stream/promises';
import { test } from 'node:test';

import { createClock } from '@sinonjs/fake-timers';

import { isErrno } from '@zukhruf/fs';

import { Client, PrivateKey } from './index.ts';
import { type Sshd, startSshd } from './testing/sshd.ts';

const noSshd = process.platform === 'win32' ? 'Windows has no sshd' : false;

async function dial(sshd: Sshd): Promise<Client> {
  const key = PrivateKey.parse(await readFile(sshd.userKey));
  return Client.dial(`127.0.0.1:${sshd.port}`, {
    user: userInfo().username,
    auth: [{ type: 'publickey', signers: async () => [key] }],
    hostKey: () => undefined,
    clock: createClock(),
  });
}

/** A server that answers each connection with `reply(input)` after the client ends its input. */
async function listenOnce(
  path: string | { readonly port: 0; readonly host: '127.0.0.1' },
  reply: (input: string) => string,
): Promise<Server> {
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    void inputOf(socket).then((input) => socket.end(reply(input)));
  });
  server.listen(path);
  await once(server, 'listening');
  return server;
}

/** The input of a stream to its end. text() would destroy the stream at the end, before an answer. */
async function inputOf(stream: Duplex): Promise<string> {
  let input = '';
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    input += String(chunk);
  }
  return input;
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server listens on no TCP port.');
  }
  return address.port;
}

async function exchange(stream: Duplex, input: string): Promise<string> {
  stream.end(input);
  return text(stream);
}

test(
  "dial('tcp') reaches a TCP server on the remote host, and the data goes both ways",
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    await using server = await listenOnce(
      { port: 0, host: '127.0.0.1' },
      (input) => `got ${input}`,
    );

    // Act
    const stream = await client.dial('tcp', `127.0.0.1:${portOf(server)}`);

    // Assert
    assert.equal(await exchange(stream, 'ping'), 'got ping');
  },
);

test(
  "dial('unix') reaches a Unix socket on the remote host, and the data goes both ways",
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    const path = join(sshd.directory, 'remote.sock');
    await using _server = await listenOnce(path, (input) => `got ${input}`);

    // Act
    const stream = await client.dial('unix', path);

    // Assert
    assert.equal(await exchange(stream, 'ping'), 'got ping');
  },
);

test(
  'dial to a port where nothing listens rejects with the reason of the server',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    const closed = await listenOnce({ port: 0, host: '127.0.0.1' }, () => '');
    const port = portOf(closed);
    await closed[Symbol.asyncDispose]();

    // Act
    const dialed = client.dial('tcp', `127.0.0.1:${port}`);

    // Assert
    await assert.rejects(
      dialed,
      /^Error: ssh: the server refused the channel: \S/,
    );
  },
);

test(
  'dial with an aborted signal rejects with its reason',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    await using server = await listenOnce(
      { port: 0, host: '127.0.0.1' },
      () => '',
    );
    const reason = new Error('the caller gave up');

    // Act
    const dialed = client.dial('tcp', `127.0.0.1:${portOf(server)}`, {
      signal: AbortSignal.abort(reason),
    });

    // Assert
    await assert.rejects(dialed, (error) => error === reason);
  },
);

test(
  'the end of the write side of a dialed stream ends the input of the remote socket, and the remote side can still answer',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    const remoteEnded = Promise.withResolvers<Socket>();
    await using server = createServer({ allowHalfOpen: true }, (socket) => {
      socket.resume();
      socket.once('end', () => remoteEnded.resolve(socket));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const stream = await client.dial('tcp', `127.0.0.1:${portOf(server)}`);

    // Act
    stream.end();

    // Assert
    const remote = await remoteEnded.promise;
    remote.end('after your end');
    assert.equal(await text(stream), 'after your end');
  },
);

test(
  'destroy of a dialed stream closes the remote socket',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    const remoteClosed = Promise.withResolvers<void>();
    const accepted = Promise.withResolvers<void>();
    await using server = createServer((socket) => {
      socket.resume();
      socket.on('error', () => undefined);
      socket.once('close', () => remoteClosed.resolve());
      accepted.resolve();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const stream = await client.dial('tcp', `127.0.0.1:${portOf(server)}`);
    await accepted.promise;

    // Act
    stream.destroy();

    // Assert
    await remoteClosed.promise;
    assert.equal(stream.destroyed, true);
  },
);

test(
  'when the connection is lost, an open dialed stream fails with the error that ended the connection as its cause',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    await using server = createServer((socket) => socket.resume());
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const ended = client.wait().then(
      () => assert.fail('the connection ended with no error'),
      (error: unknown) => error,
    );
    const stream = await client.dial('tcp', `127.0.0.1:${portOf(server)}`);
    const failed = new Promise<unknown>((resolve) =>
      finished(stream, (error) => resolve(error)),
    );

    // Act: the sshd process of the connection dies, and its socket closes.
    sshd.kill('SIGKILL');

    // Assert
    const error = await failed;
    assert.ok(Error.isError(error));
    assert.equal(error.cause, await ended);
  },
);

test(
  'a local forward of node:net and client.dial, as ADR 0009 writes it, carries a connection to a remote TCP server',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    await using remote = await listenOnce(
      { port: 0, host: '127.0.0.1' },
      (input) => `remote got ${input}`,
    );
    const carry = async (socket: Socket): Promise<void> => {
      const stream = await client
        .dial('tcp', `127.0.0.1:${portOf(remote)}`)
        .catch(() => undefined);
      if (!stream) return void socket.destroy();
      await Promise.allSettled([
        pipeline(socket, stream),
        pipeline(stream, socket),
      ]);
    };
    await using forward = createServer({ allowHalfOpen: true }, (socket) => {
      void carry(socket);
    });
    forward.listen(0, '127.0.0.1');
    await once(forward, 'listening');

    // Act
    const local = connect(portOf(forward), '127.0.0.1');

    // Assert
    assert.equal(await exchange(local, 'ping'), 'remote got ping');
  },
);

test(
  "listen('tcp', '127.0.0.1:0') gets a port of the server, and a connection to it comes to the listener with its origin",
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    const arrived = Promise.withResolvers<{ stream: Duplex; origin: string }>();

    // Act
    await using listener = await client.listen(
      'tcp',
      '127.0.0.1:0',
      (stream, origin) => arrived.resolve({ stream, origin }),
    );
    const [host, port] = listener.address.split(':');
    const peer = connect(Number(port), host);
    await once(peer, 'connect');

    // Assert
    assert.equal(host, '127.0.0.1');
    assert.notEqual(Number(port), 0);
    const { stream, origin } = await arrived.promise;
    assert.equal(origin, `127.0.0.1:${peer.localPort}`);
    const answered = text(peer);
    void inputOf(stream).then((input) => stream.end(`got ${input}`));
    peer.end('ping');
    assert.equal(await answered, 'got ping');
  },
);

test(
  "listen('unix', path) makes the server listen on the path, and a connection to it comes to the listener",
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    const path = join(sshd.directory, 'listened.sock');

    // Act
    await using listener = await client.listen('unix', path, (stream) => {
      void inputOf(stream).then((input) => stream.end(`got ${input}`));
    });
    const peer = connect(path);

    // Assert
    assert.equal(listener.address, path);
    assert.equal(await exchange(peer, 'ping'), 'got ping');
  },
);

test(
  'listener.close() cancels the forward, so the server refuses a new connection to the port',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using client = await dial(sshd);
    const listener = await client.listen('tcp', '127.0.0.1:0', (stream) =>
      stream.destroy(),
    );
    const port = Number(listener.address.split(':')[1]);

    // Act
    await listener.close();

    // Assert
    const [error] = await once(connect(port, '127.0.0.1'), 'error');
    assert.ok(isErrno(error, 'ECONNREFUSED'));
  },
);

test(
  'listener.close() after the close of the client resolves',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const client = await dial(sshd);
    const listener = await client.listen('tcp', '127.0.0.1:0', (stream) =>
      stream.destroy(),
    );
    await client.close();

    // Act
    const closed = listener.close();

    // Assert
    await closed;
  },
);
