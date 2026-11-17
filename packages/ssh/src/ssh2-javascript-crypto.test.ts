import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { text } from 'node:stream/consumers';
import { test } from 'node:test';

import { Client } from 'ssh2';

import { startSshd } from './testing/sshd.ts';

const noSshd = process.platform === 'win32' ? 'Windows has no sshd' : false;

test(
  'ssh2 logs in to OpenSSH and runs a command with its native crypto binding absent',
  { skip: noSshd },
  async () => {
    // Arrange
    const nativeBinding = join(
      dirname(createRequire(import.meta.url).resolve('ssh2')),
      'protocol/crypto/build/Release/sshcrypto.node',
    );
    await using sshd = await startSshd();
    const [, keyData] = sshd.hostPublicKey.split(' ');
    assert.ok(keyData);
    const hostKey = Buffer.from(keyData, 'base64');
    const client = new Client();
    try {
      const ready = new Promise<void>((resolve, reject) => {
        client.once('ready', resolve).once('error', reject);
      });
      client.connect({
        host: '127.0.0.1',
        port: sshd.port,
        username: userInfo().username,
        privateKey: await readFile(sshd.userKey),
        hostVerifier: (key: Buffer) => key.equals(hostKey),
      });
      await ready;

      // Act
      const stdout = await new Promise<string>((resolve, reject) => {
        client.exec('echo ok', (error, channel) => {
          if (error) {
            reject(error);
            return;
          }
          text(channel).then(resolve, reject);
        });
      });

      // Assert
      assert.equal(stdout, 'ok\n');
      assert.equal(existsSync(nativeBinding), false);
    } finally {
      client.end();
    }
  },
);
