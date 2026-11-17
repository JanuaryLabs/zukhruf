import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { startSshd } from './testing/sshd.ts';

const noSshd = process.platform === 'win32' ? 'Windows has no sshd' : false;

test(
  'the OpenSSH client logs in with the user key to an sshd that runs without root and runs a command',
  { skip: noSshd },
  async () => {
    // Arrange
    await using sshd = await startSshd();
    const clientConfig = join(sshd.directory, 'ssh_config');
    await writeFile(clientConfig, '');
    const knownHosts = join(sshd.directory, 'known_hosts');
    await writeFile(
      knownHosts,
      `[127.0.0.1]:${sshd.port} ${sshd.hostPublicKey}\n`,
    );

    // Act
    const { stdout } = await promisify(execFile)('ssh', [
      '-F',
      clientConfig,
      '-p',
      String(sshd.port),
      '-i',
      sshd.userKey,
      '-o',
      `UserKnownHostsFile=${knownHosts}`,
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'BatchMode=yes',
      '127.0.0.1',
      'echo ok',
    ]);

    // Assert
    assert.equal(stdout, 'ok\n');
  },
);
