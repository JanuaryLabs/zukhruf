import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  access,
  chmod,
  mkdir,
  mkdtempDisposable,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from './temporary-files.ts';

test(
  'disposal rejects with the error when the removal fails',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using parent = await mkdtempDisposable(
      join(tmpdir(), 'testing-fs-parent-'),
    );
    const directory = await new TemporaryFiles().directory('locked-', {
      parent: parent.path,
    });
    await chmod(parent.path, 0o555);
    try {
      await assert.rejects(directory.cleanup(), { code: 'EACCES' });
      await access(directory.path);
    } finally {
      await chmod(parent.path, 0o755);
    }
  },
);

test('the path is the real path of a new directory in os.tmpdir() that starts with the prefix', async () => {
  await using directory = await new TemporaryFiles().directory(
    'testing-fs-real-',
  );

  assert.equal(directory.path, await realpath(directory.path));
  assert.equal(dirname(directory.path), await realpath(tmpdir()));
  assert.match(basename(directory.path), /^testing-fs-real-./);
});

test('a parent that is a symbolic link gives a path under the real path of its target', async () => {
  await using target = await mkdtempDisposable(
    join(tmpdir(), 'testing-fs-target-'),
  );
  const link = join(tmpdir(), `testing-fs-link-${randomUUID()}`);
  // A junction needs no admin rights on Windows; POSIX ignores the type.
  await symlink(target.path, link, 'junction');
  try {
    await using directory = await new TemporaryFiles().directory('child-', {
      parent: link,
    });

    assert.equal(dirname(directory.path), await realpath(target.path));
  } finally {
    await rm(link, { force: true });
  }
});

test('a parent holds the new directory', async () => {
  await using parent = await mkdtempDisposable(
    join(tmpdir(), 'testing-fs-parent-'),
  );
  const files = new TemporaryFiles();

  await using first = await files.directory('child-', { parent: parent.path });
  await using second = await files.directory('child-', { parent: parent.path });

  assert.equal(dirname(first.path), await realpath(parent.path));
  assert.equal(dirname(second.path), await realpath(parent.path));
  assert.notEqual(first.path, second.path);
});

test('disposal removes the directory and all that it holds', async () => {
  const directory = await new TemporaryFiles().directory('testing-fs-full-');
  await mkdir(join(directory.path, 'nested'));
  await writeFile(join(directory.path, 'nested', 'report.json'), '{}');

  await directory.cleanup();

  await assert.rejects(access(directory.path), { code: 'ENOENT' });
});
