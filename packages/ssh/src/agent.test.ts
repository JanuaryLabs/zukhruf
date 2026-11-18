import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { type KeyObject, createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { userInfo } from 'node:os';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { createClock } from '@sinonjs/fake-timers';

import { poll } from '@zukhruf/async';

import { AgentClient } from './agent.ts';
import { Client, PrivateKey, PublicKey } from './index.ts';
import { startSshAgent } from './testing/ssh-agent.ts';
import { startSshd } from './testing/sshd.ts';

const run = promisify(execFile);

const noAgent =
  process.platform === 'win32'
    ? 'the tests run OpenSSH ssh-agent on a Unix socket'
    : false;

test(
  'a request on a socket that the agent closed rejects',
  { skip: noAgent },
  async () => {
    // Arrange
    await using agent = await startSshAgent();
    const socket = connect(agent.socket);
    try {
      const client = new AgentClient(socket);
      await agent[Symbol.asyncDispose]();

      // Act
      const listed = client.list();

      // Assert
      await assert.rejects(listed, /ssh: the connection to the agent closed/);
    } finally {
      // The death of the agent ends the socket on macOS, and fails it with
      // ECONNRESET on Linux, which the disposal of `await using` throws.
      socket.destroy();
    }
  },
);

test(
  'remove of a key that the agent does not hold rejects with the refusal of the agent',
  { skip: noAgent },
  async () => {
    // Arrange
    await using agent = await startSshAgent();
    const keyFile = await agent.generateKey('absent');
    await using socket = connect(agent.socket);
    const client = new AgentClient(socket);

    // Act
    const removed = client.remove(await publicKeyOf(keyFile));

    // Assert
    await assert.rejects(removed, /ssh: the agent refused to remove/);
  },
);

test(
  'list gives each key that ssh-add added, with its comment',
  { skip: noAgent },
  async () => {
    // Arrange
    await using agent = await startSshAgent();
    const first = await agent.generateKey('first key');
    const second = await agent.generateKey('second key', 'rsa');
    await agent.sshAdd([first, second]);
    await using socket = connect(agent.socket);
    const client = new AgentClient(socket);

    // Act
    const keys = await client.list();

    // Assert
    assert.deepEqual(
      keys.map(({ key, comment }) => [key.fingerprint(), comment]),
      [
        [await agent.fingerprint(first), 'first key'],
        [await agent.fingerprint(second), 'second key'],
      ],
    );
  },
);

test(
  'the signers of the agent log in to sshd with publickey',
  { skip: noAgent },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    await using agent = await startSshAgent();
    await agent.sshAdd([sshd.userKey]);
    await using socket = connect(agent.socket);
    const client = new AgentClient(socket);

    // Act
    await using connection = await Client.dial(`127.0.0.1:${sshd.port}`, {
      user: userInfo().username,
      auth: [{ type: 'publickey', signers: () => client.signers() }],
      hostKey: () => undefined,
      clock: createClock(),
    });

    // Assert
    assert.equal(
      String(await connection.newSession().output('echo ok')),
      'ok\n',
    );
  },
);

test(
  'sign with an ed25519 key gives a signature that the public key verifies',
  { skip: noAgent },
  async () => {
    // Arrange
    await using agent = await startSshAgent();
    const keyFile = await agent.generateKey('signing');
    await agent.sshAdd([keyFile]);
    await using socket = connect(agent.socket);
    const client = new AgentClient(socket);
    const data = Buffer.from('the data to sign');

    // Act
    const signature = await client.sign(await publicKeyOf(keyFile), data);

    // Assert
    assert.ok(verify(null, data, await pkcs8Of(keyFile), signature));
  },
);

test(
  'sign with an RSA key and rsa-sha2-256 gives a SHA-256 signature that the public key verifies',
  { skip: noAgent },
  async () => {
    // Arrange
    await using agent = await startSshAgent();
    const keyFile = await agent.generateKey('rsa signing', 'rsa');
    await agent.sshAdd([keyFile]);
    await using socket = connect(agent.socket);
    const client = new AgentClient(socket);
    const data = Buffer.from('the data to sign');

    // Act
    const signature = await client.sign(await publicKeyOf(keyFile), data, {
      algorithm: 'rsa-sha2-256',
    });

    // Assert
    assert.ok(verify('sha256', data, await pkcs8Of(keyFile), signature));
  },
);

for (const type of ['ed25519', 'rsa', 'ecdsa'] as const) {
  test(
    `add of an ${type} key: ssh-add lists it with its comment, and the agent signs with it`,
    { skip: noAgent },
    async () => {
      // Arrange
      await using agent = await startSshAgent();
      const keyFile = await agent.generateKey(`${type} file`, type);
      await using socket = connect(agent.socket);
      const client = new AgentClient(socket);
      const data = Buffer.from('the data to sign');

      // Act
      await client.add(PrivateKey.parse(await readFile(keyFile)), {
        comment: `added ${type}`,
      });

      // Assert
      const [line] = await agent.listed();
      assert.ok(
        line?.includes(`${await agent.fingerprint(keyFile)} added ${type} (`),
      );
      const signature = await client.sign(await publicKeyOf(keyFile), data);
      assert.ok(verifies(type, data, await pkcs8Of(keyFile), signature));
    },
  );
}

test(
  'add with a lifetime in ms: the agent drops the key once the lifetime ends',
  { skip: noAgent },
  async (t) => {
    // Arrange
    await using agent = await startSshAgent();
    const keyFile = await agent.generateKey('short lived');
    await using socket = connect(agent.socket);
    const client = new AgentClient(socket);

    // Act
    await client.add(PrivateKey.parse(await readFile(keyFile)), {
      lifetime: 3000,
    });

    // Assert
    // ssh-agent counts a lifetime in whole seconds of its monotonic clock
    // (ssh-agent.c:1313, misc.c:1764-1770 of OpenSSH 10.0p1), so a key of
    // 3 s goes between 2 s and 3 s after the add. Read as 3000 s, the key
    // would stay until the limit of the test.
    assert.equal((await agent.listed()).length, 1);
    await poll(
      async () => ((await agent.listed()).length === 0 ? true : undefined),
      { interval: 100, signal: t.signal, clock: globalThis },
    );
  },
);

test(
  'add with confirm: the agent asks before it signs, and signs nothing when the answer is no',
  { skip: noAgent },
  async () => {
    // Arrange
    await using agent = await startSshAgent({
      environment: {
        SSH_ASKPASS: '/usr/bin/false',
        SSH_ASKPASS_REQUIRE: 'force',
        DISPLAY: ':0',
      },
    });
    const keyFile = await agent.generateKey('confirmed');
    await using socket = connect(agent.socket);
    const client = new AgentClient(socket);
    await client.add(PrivateKey.parse(await readFile(keyFile)), {
      confirm: true,
    });

    // Act
    const signed = client.sign(await publicKeyOf(keyFile), Buffer.from('x'));

    // Assert
    await assert.rejects(signed, /ssh: the agent refused to sign/);
  },
);

test(
  'remove drops one key, and removeAll drops the rest',
  { skip: noAgent },
  async () => {
    // Arrange
    await using agent = await startSshAgent();
    const kept = await agent.generateKey('kept');
    const removed = await agent.generateKey('removed');
    await agent.sshAdd([kept, removed]);
    await using socket = connect(agent.socket);
    const client = new AgentClient(socket);

    // Act
    await client.remove(await publicKeyOf(removed));
    const afterRemove = await agent.listed();
    await client.removeAll();

    // Assert
    assert.deepEqual(
      afterRemove.map((line) => line.split(' ')[1]),
      [await agent.fingerprint(kept)],
    );
    assert.deepEqual(await agent.listed(), []);
  },
);

test(
  'lock hides the keys, unlock with another passphrase rejects, and unlock with the passphrase shows them again',
  { skip: noAgent },
  async () => {
    // Arrange
    await using agent = await startSshAgent();
    const keyFile = await agent.generateKey('locked');
    await agent.sshAdd([keyFile]);
    await using socket = connect(agent.socket);
    const client = new AgentClient(socket);

    // Act
    await client.lock('secret');
    const whileLocked = await agent.listed();
    const wrongUnlock = client.unlock('not the secret');
    await assert.rejects(wrongUnlock, /ssh: the agent refused to unlock/);
    await client.unlock('secret');

    // Assert
    assert.deepEqual(whileLocked, []);
    assert.equal((await agent.listed()).length, 1);
  },
);

async function publicKeyOf(keyFile: string): Promise<PublicKey> {
  return PublicKey.parseAuthorizedKey(await readFile(`${keyFile}.pub`, 'utf8'))
    .key;
}

/** The public key of the file for node:crypto: from its wire form for ed25519 (RFC 8709 §4), which ssh-keygen -e cannot write as PKCS#8, else as OpenSSH's ssh-keygen -e writes it. */
async function pkcs8Of(keyFile: string): Promise<KeyObject> {
  const key = await publicKeyOf(keyFile);
  if (key.type === 'ssh-ed25519') {
    const x = Buffer.from(key.wire).subarray(-32).toString('base64url');
    return createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x },
      format: 'jwk',
    });
  }
  const { stdout } = await run('ssh-keygen', [
    '-e',
    '-m',
    'PKCS8',
    '-f',
    `${keyFile}.pub`,
  ]);
  return createPublicKey(stdout);
}

/** Verifies an SSH signature blob of the key type, RFC 8709, RFC 8332 ssh-rsa, RFC 5656 §3.1.2. */
function verifies(
  type: 'ed25519' | 'rsa' | 'ecdsa',
  data: Buffer,
  publicKey: KeyObject,
  blob: Uint8Array,
): boolean {
  if (type === 'ed25519') return verify(null, data, publicKey, blob);
  if (type === 'rsa') return verify('sha1', data, publicKey, blob);
  const read = (offset: number): [Buffer, number] => {
    const length = Buffer.from(blob).readUInt32BE(offset);
    const end = offset + 4 + length;
    return [Buffer.from(blob.subarray(offset + 4, end)), end];
  };
  const [r, afterR] = read(0);
  const [s] = read(afterR);
  const fixed = (value: Buffer) =>
    Buffer.concat([Buffer.alloc(32), value]).subarray(-32);
  return verify(
    'sha256',
    data,
    { key: publicKey, dsaEncoding: 'ieee-p1363' },
    Buffer.concat([fixed(r), fixed(s)]),
  );
}
