import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';

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

test(
  'in a process whose PATH has no sshd, startSshd rejects with an error that names the PATH, and uses no sshd outside it',
  { skip: noSshd },
  async () => {
    // Arrange
    await using directory = await new TemporaryFiles().directory('sshd-', {
      parent: '/tmp',
    });
    const { stdout } = await promisify(execFile)('sh', [
      '-c',
      'command -v ssh-keygen',
    ]);
    await symlink(stdout.trim(), join(directory.path, 'ssh-keygen'));
    const helper = new URL('testing/sshd.ts', import.meta.url).href;

    // Act
    const started = promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { startSshd } from '${helper}'; await using sshd = await startSshd();`,
      ],
      { env: { ...process.env, PATH: directory.path } },
    );

    // Assert
    await assert.rejects(started, (error) => {
      assert.ok(Error.isError(error) && 'stderr' in error);
      assert.match(
        String(error.stderr),
        /The OpenSSH server sshd is missing from the PATH/,
      );
      return true;
    });
  },
);
