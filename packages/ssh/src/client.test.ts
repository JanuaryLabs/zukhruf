import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { appendFile, readFile } from 'node:fs/promises';
import { type Server, type Socket, connect, createServer } from 'node:net';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setImmediate as nextMacrotask } from 'node:timers/promises';
import { promisify } from 'node:util';

import { createClock } from '@sinonjs/fake-timers';

import {
  AuthenticationError,
  Client,
  PassphraseMissingError,
  PrivateKey,
  PublicKey,
} from './index.ts';
import { startSshd } from './testing/sshd.ts';

const run = promisify(execFile);
const noSshd = process.platform === 'win32' ? 'Windows has no sshd' : false;

test(
  'a host key that the callback refuses rejects the dial with the error of the callback, and asks no signer',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const key = PrivateKey.parse(await readFile(sshd.userKey));
    const refusal = new Error('not this key');
    let signersAsked = false;

    // Act
    const dial = Client.dial(`127.0.0.1:${sshd.port}`, {
      user: userInfo().username,
      auth: [
        {
          type: 'publickey',
          signers: async () => {
            signersAsked = true;
            return [key];
          },
        },
      ],
      hostKey: () => {
        throw refusal;
      },
      clock: createClock(),
    });

    // Assert
    await assert.rejects(dial, (error) => error === refusal);
    assert.equal(signersAsked, false);
  },
);

test(
  'Client.dial logs in with a private key, and the host key callback gets the host, the port and the key of the server',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const key = PrivateKey.parse(await readFile(sshd.userKey));
    const checked: [string, number, string][] = [];

    // Act
    await using client = await Client.dial(`127.0.0.1:${sshd.port}`, {
      user: userInfo().username,
      auth: [{ type: 'publickey', signers: async () => [key] }],
      hostKey: (hostname, port, hostKey) => {
        checked.push([hostname, port, hostKey.toString()]);
      },
      clock: createClock(),
    });

    // Assert
    const [type, blob] = sshd.hostPublicKey.split(' ');
    assert.deepEqual(checked, [['127.0.0.1', sshd.port, `${type} ${blob}`]]);
    assert.equal(client.user, userInfo().username);
    assert.match(client.serverVersion, /^SSH-2\.0-OpenSSH_\S+/);
  },
);

test(
  'a key that the server does not accept rejects the dial with AuthenticationError, which lists the methods tried and the methods of the server',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const otherKey = join(sshd.directory, 'id_other');
    await run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', otherKey]);
    const key = PrivateKey.parse(await readFile(otherKey));

    // Act
    const dial = Client.dial(`127.0.0.1:${sshd.port}`, {
      user: userInfo().username,
      auth: [{ type: 'publickey', signers: async () => [key] }],
      hostKey: () => undefined,
      clock: createClock(),
    });

    // Assert
    await assert.rejects(dial, (error) => {
      assert.ok(error instanceof AuthenticationError);
      assert.deepEqual(error.attempted, ['none', 'publickey']);
      assert.ok(error.allowed.includes('publickey'));
      return true;
    });
  },
);

test(
  'PrivateKey.parse of an encrypted key with no passphrase throws PassphraseMissingError with the public key of the file',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const file = join(sshd.directory, 'id_encrypted');
    await run('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      'secret',
      '-f',
      file,
    ]);
    const publicKey = PublicKey.parseAuthorizedKey(
      await readFile(`${file}.pub`, 'utf8'),
    ).key;
    const data = await readFile(file);

    // Act
    const parse = () => PrivateKey.parse(data);

    // Assert
    assert.throws(parse, (error) => {
      assert.ok(error instanceof PassphraseMissingError);
      assert.ok(error.publicKey?.equals(publicKey));
      return true;
    });
  },
);

test(
  'an encrypted key parsed with its passphrase logs in',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const file = join(sshd.directory, 'id_encrypted');
    await run('ssh-keygen', [
      '-q',
      '-t',
      'ed25519',
      '-N',
      'secret',
      '-f',
      file,
    ]);
    // sshd reads authorized_keys at each login; the package only reads it.
    await appendFile(
      join(sshd.directory, 'authorized_keys'),
      await readFile(`${file}.pub`),
    );
    const key = PrivateKey.parse(await readFile(file), 'secret');

    // Act
    await using client = await Client.dial(`127.0.0.1:${sshd.port}`, {
      user: userInfo().username,
      auth: [{ type: 'publickey', signers: async () => [key] }],
      hostKey: () => undefined,
      clock: createClock(),
    });

    // Assert
    assert.equal(client.user, userInfo().username);
  },
);

test(
  'an RSA key logs in with an rsa-sha2 signature',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const file = join(sshd.directory, 'id_rsa');
    await run('ssh-keygen', [
      '-q',
      '-t',
      'rsa',
      '-b',
      '3072',
      '-N',
      '',
      '-f',
      file,
    ]);
    // sshd reads authorized_keys at each login; the package only reads it.
    await appendFile(
      join(sshd.directory, 'authorized_keys'),
      await readFile(`${file}.pub`),
    );
    const key = PrivateKey.parse(await readFile(file));

    // Act
    await using client = await Client.dial(`127.0.0.1:${sshd.port}`, {
      user: userInfo().username,
      auth: [{ type: 'publickey', signers: async () => [key] }],
      hostKey: () => undefined,
      clock: createClock(),
    });

    // Assert
    assert.equal(client.user, userInfo().username);
  },
);

function portOf(server: Server): number {
  const address = server.address();
  assert.ok(address !== null && typeof address === 'object');
  return address.port;
}

// A TCP server that accepts each connection and never speaks.
async function startSilentServer(): Promise<
  AsyncDisposable & { port: number; accepted: Promise<unknown> }
> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => sockets.add(socket));
  const accepted = once(server, 'connection');
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: portOf(server),
    accepted,
    async [Symbol.asyncDispose]() {
      for (const socket of sockets) socket.destroy();
      server.close();
      await once(server, 'close');
    },
  };
}

test('connectTimeout rejects the dial with a TimeoutError when it passes on the clock of the config, and not before', async () => {
  // Arrange
  await using server = await startSilentServer();
  const clock = createClock();
  let settled = false;
  const dial = Client.dial(`127.0.0.1:${server.port}`, {
    user: 'nobody',
    auth: [],
    hostKey: () => undefined,
    clock,
    connectTimeout: 5000,
  });
  dial.then(
    () => (settled = true),
    () => (settled = true),
  );
  await server.accepted;

  // Act
  clock.tick(4999);
  await nextMacrotask();
  const settledBefore = settled;
  clock.tick(1);

  // Assert
  assert.equal(settledBefore, false);
  await assert.rejects(dial, (error) => {
    assert.ok(error instanceof DOMException);
    assert.equal(error.name, 'TimeoutError');
    return true;
  });
});

test('a signal that aborts during the handshake rejects the dial with its reason', async () => {
  // Arrange
  await using server = await startSilentServer();
  const controller = new AbortController();
  const reason = new Error('stop');
  const dial = Client.dial(
    `127.0.0.1:${server.port}`,
    {
      user: 'nobody',
      auth: [],
      hostKey: () => undefined,
      clock: createClock(),
    },
    { signal: controller.signal },
  );
  await server.accepted;

  // Act
  controller.abort(reason);

  // Assert
  await assert.rejects(dial, (error) => error === reason);
});

test('a signal that has aborted rejects the dial with its reason', async () => {
  // Arrange
  const reason = new Error('stop');

  // Act
  const dial = Client.dial(
    '127.0.0.1:22',
    {
      user: 'nobody',
      auth: [],
      hostKey: () => undefined,
      clock: createClock(),
    },
    { signal: AbortSignal.abort(reason) },
  );

  // Assert
  await assert.rejects(dial, (error) => error === reason);
});

test('a refused TCP connect rejects the dial with the error of Node.js and its code', async () => {
  // Arrange
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = portOf(server);
  server.close();
  await once(server, 'close');

  // Act
  const dial = Client.dial(`127.0.0.1:${port}`, {
    user: 'nobody',
    auth: [],
    hostKey: () => undefined,
    clock: createClock(),
  });

  // Assert
  await assert.rejects(dial, { code: 'ECONNREFUSED' });
});

test(
  'hostKeyAlgorithms limits the host key algorithms that the client offers',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const key = PrivateKey.parse(await readFile(sshd.userKey));

    const offer = (hostKeyAlgorithms: string[]) =>
      Client.dial(`127.0.0.1:${sshd.port}`, {
        user: userInfo().username,
        auth: [{ type: 'publickey', signers: async () => [key] }],
        hostKey: () => undefined,
        hostKeyAlgorithms,
        clock: createClock(),
      });

    // Act
    const refusal: unknown = await offer(['rsa-sha2-256']).then(
      () => undefined,
      (error: unknown) => error,
    );
    await using client = await offer(['ssh-ed25519']);

    // Assert
    assert.ok(Error.isError(refusal));
    assert.match(refusal.message, /no matching host key/);
    assert.equal(client.user, userInfo().username);
  },
);

test(
  'close() ends the connection: wait() resolves, and a later close() resolves',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const key = PrivateKey.parse(await readFile(sshd.userKey));
    const client = await Client.dial(`127.0.0.1:${sshd.port}`, {
      user: userInfo().username,
      auth: [{ type: 'publickey', signers: async () => [key] }],
      hostKey: () => undefined,
      clock: createClock(),
    });

    // Act
    await client.close();

    // Assert
    await client.wait();
    await client.close();
  },
);

test(
  'the disposal of a client ends the connection, and wait() resolves',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const key = PrivateKey.parse(await readFile(sshd.userKey));
    let wait: Promise<void>;

    // Act
    {
      await using client = await Client.dial(`127.0.0.1:${sshd.port}`, {
        user: userInfo().username,
        auth: [{ type: 'publickey', signers: async () => [key] }],
        hostKey: () => undefined,
        clock: createClock(),
      });
      wait = client.wait();
    }

    // Assert
    await wait;
  },
);

test(
  'a connection that the server loses after the start rejects wait(), and does not resolve it as a close does',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const key = PrivateKey.parse(await readFile(sshd.userKey));
    await using client = await Client.dial(`127.0.0.1:${sshd.port}`, {
      user: userInfo().username,
      auth: [{ type: 'publickey', signers: async () => [key] }],
      hostKey: () => undefined,
      clock: createClock(),
    });

    // Act
    sshd.kill('SIGKILL');

    // Assert
    await assert.rejects(client.wait(), /closed the connection/);
  },
);

test(
  'keepalive ends a connection to a server that stops answering, and wait() rejects with the keepalive error',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const key = PrivateKey.parse(await readFile(sshd.userKey));
    await using client = await Client.dial(`127.0.0.1:${sshd.port}`, {
      user: userInfo().username,
      auth: [{ type: 'publickey', signers: async () => [key] }],
      hostKey: () => undefined,
      clock: createClock(),
      keepalive: { interval: 100, countMax: 1 },
    });

    // Act
    sshd.kill('SIGSTOP');

    // Assert
    await assert.rejects(client.wait(), /keepalive/i);
  },
);

test(
  'Client.handshake logs in over a socket that the caller connected',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const key = PrivateKey.parse(await readFile(sshd.userKey));
    const socket = connect(sshd.port, '127.0.0.1');
    await once(socket, 'connect');

    // Act
    await using client = await Client.handshake(
      socket,
      `127.0.0.1:${sshd.port}`,
      {
        user: userInfo().username,
        auth: [{ type: 'publickey', signers: async () => [key] }],
        hostKey: () => undefined,
        clock: createClock(),
      },
    );

    // Assert
    assert.match(client.serverVersion, /^SSH-2\.0-OpenSSH_/);
  },
);

test('hostKeyAlgorithms that name no algorithm of the client reject the dial before a connect, instead of offering every algorithm', async () => {
  // Arrange
  await using server = await startSilentServer();
  let connected = false;
  void server.accepted.then(() => (connected = true));

  // Act
  const dial = Client.dial(`127.0.0.1:${server.port}`, {
    user: 'nobody',
    auth: [],
    hostKey: () => undefined,
    hostKeyAlgorithms: ['ssh-ed25519-cert-v01@openssh.com'],
    clock: createClock(),
  });

  // Assert
  await assert.rejects(dial, /ssh-ed25519-cert-v01@openssh\.com/);
  await nextMacrotask();
  assert.equal(connected, false);
});
