import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { TemporaryFiles } from '@zukhruf/fs';

import { FullDiskAccess } from './index.ts';

const run = promisify(execFile);

describe('the preflight of Full Disk Access', { concurrency: true }, () => {
  test('a file and a folder that open are readable', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('tcc-');
    const file = join(scratch.path, 'chat.db');
    await writeFile(file, 'rows');

    // Act
    const result = await new FullDiskAccess().preflight([file, scratch.path]);

    // Assert
    assert.deepEqual(result.readable, [file, scratch.path]);
    assert.deepEqual(result.denied, []);
    assert.deepEqual(result.missing, []);
  });

  test('a file that its mode keeps from the process is denied', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('tcc-');
    const file = join(scratch.path, 'chat.db');
    await writeFile(file, 'rows');
    await chmod(file, 0o000);

    try {
      // Act
      const result = await new FullDiskAccess().preflight([file]);

      // Assert
      assert.deepEqual(result.denied, [file]);
      assert.deepEqual(result.readable, []);
    } finally {
      await chmod(file, 0o600);
    }
  });

  test('a file that macOS keeps from the process is denied', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('tcc-');
    const file = join(await realpath(scratch.path), 'chat.db');
    await writeFile(file, 'rows');
    // This Mac gives the test process Full Disk Access, so TCC cannot deny a
    // read here. The sandbox of macOS denies it in the same way: the kernel
    // answers the open with EPERM.
    const profile = `(version 1)(allow default)(deny file-read-data (literal "${file}"))`;
    const program = `import { FullDiskAccess } from ${JSON.stringify(fileURLToPath(new URL('./index.ts', import.meta.url)))};
const result = await new FullDiskAccess().preflight([${JSON.stringify(file)}]);
console.log(JSON.stringify(result));`;

    // Act
    const { stdout } = await run('/usr/bin/sandbox-exec', [
      '-p',
      profile,
      process.execPath,
      '--input-type=module',
      '--eval',
      program,
    ]);

    // Assert
    const result = JSON.parse(stdout);
    assert.deepEqual(result.denied, [file]);
    assert.deepEqual(result.readable, []);
  });

  test('a path that is not there, or that is under a file, is missing', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('tcc-');
    const file = join(scratch.path, 'chat.db');
    await writeFile(file, 'rows');
    const absent = join(scratch.path, 'Mail');
    const underFile = join(file, 'V10');

    // Act
    const result = await new FullDiskAccess().preflight([absent, underFile]);

    // Assert
    assert.deepEqual(result.missing, [absent, underFile]);
    assert.deepEqual(result.denied, []);
  });

  test('a failure that is not a denial or a missing path is thrown', async () => {
    // Arrange
    await using scratch = await new TemporaryFiles().directory('tcc-');
    const loop = join(scratch.path, 'loop');
    await symlink(loop, loop);

    // Act and assert
    await assert.rejects(new FullDiskAccess().preflight([loop]), {
      code: 'ELOOP',
    });
  });
});
