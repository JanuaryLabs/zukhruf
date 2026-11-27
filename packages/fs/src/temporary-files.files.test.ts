import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chmod, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { test } from '@zukhruf/parameterized-test';

import { TemporaryFiles } from './temporary-files.ts';

const refused = (path: string) => (error: unknown) => {
  assert.ok(error instanceof TypeError);
  assert.equal(Reflect.get(error, 'code'), 'ERR_INVALID_ARG_VALUE');
  assert.ok(error.message.includes(JSON.stringify(path)), error.message);
  return true;
};

/** A file under a file: the write of the second path fails. */
const unwritable = { a: 'a file', 'a/b': 'under a file' };
const failedWrite = { code: /^(EEXIST|ENOTDIR)$/ };

test('each file of files is in the new folder with its content, and a nested path makes its folders', async () => {
  // Act
  await using folder = await new TemporaryFiles().directory('fs-', {
    files: { 'nx.json': '{}', 'src/lib/api.ts': 'export {};\n' },
  });

  // Assert
  assert.deepEqual(
    [
      await readFile(join(folder.path, 'nx.json'), 'utf8'),
      await readFile(join(folder.path, 'src/lib/api.ts'), 'utf8'),
    ],
    ['{}', 'export {};\n'],
  );
});

test('content as bytes is written byte for byte', async () => {
  // Arrange
  const bytes = new Uint8Array([0, 255, 10, 13, 128]);

  // Act
  await using folder = await new TemporaryFiles().directory('fs-', {
    files: { 'data.bin': bytes },
  });

  // Assert
  assert.deepEqual(
    new Uint8Array(await readFile(join(folder.path, 'data.bin'))),
    bytes,
  );
});

test('a write that fails rejects with the error of the write, and no folder is left in the parent', async () => {
  // Arrange
  await using parent = await new TemporaryFiles().directory('fs-parent-');

  // Act
  const made = new TemporaryFiles().directory('fs-', {
    parent: parent.path,
    files: unwritable,
  });

  // Assert
  await assert.rejects(made, failedWrite);
  assert.deepEqual(await readdir(parent.path), []);
});

void test.each(
  [
    ['../escape'],
    ['/etc/escape'],
    ['a/../../escape'],
    ['a/../b'],
    ['./a'],
    ['a//b'],
    ['a/'],
    [''],
  ] as const,
  ([path]) =>
    test(`the path ${JSON.stringify(path)} is refused with ERR_INVALID_ARG_VALUE, and no folder is left`, async () => {
      // Arrange
      await using parent = await new TemporaryFiles().directory('fs-parent-');

      // Act
      const made = new TemporaryFiles().directory('fs-', {
        parent: parent.path,
        files: { [path]: 'x' },
      });

      // Assert
      await assert.rejects(made, refused(path));
      assert.deepEqual(await readdir(parent.path), []);
    }),
);

test(
  'a refused path is refused before the folder is made: a parent where no folder can be made gives the TypeError, not EACCES',
  {
    skip:
      process.platform === 'win32' || process.getuid?.() === 0
        ? 'chmod does not refuse a folder on Windows or for root'
        : false,
  },
  async () => {
    // Arrange
    await using parent = await new TemporaryFiles().directory('fs-parent-');
    await chmod(parent.path, 0o500);
    try {
      // Act
      const made = new TemporaryFiles().directory('fs-', {
        parent: parent.path,
        files: { '../escape': 'x' },
      });

      // Assert
      await assert.rejects(made, refused('../escape'));
    } finally {
      await chmod(parent.path, 0o700);
    }
  },
);

void test.each([['a\\b'], ['C:x']] as const, ([path]) =>
  test(
    `on Windows the path ${JSON.stringify(path)} is refused too`,
    { skip: process.platform !== 'win32' },
    async () => {
      // Act
      const made = new TemporaryFiles().directory('fs-', {
        files: { [path]: 'x' },
      });

      // Assert
      await assert.rejects(made, refused(path));
    },
  ),
);

test('directorySync writes the files of files', () => {
  // Act
  using folder = new TemporaryFiles().directorySync('fs-', {
    files: { 'src/a.txt': 'a' },
  });

  // Assert
  assert.equal(readFileSync(join(folder.path, 'src/a.txt'), 'utf8'), 'a');
});

test('directorySync refuses a path that leaves the folder, and no folder is left', async () => {
  // Arrange
  await using parent = await new TemporaryFiles().directory('fs-parent-');

  // Act
  const make = () =>
    new TemporaryFiles().directorySync('fs-', {
      parent: parent.path,
      files: { '../escape': 'x' },
    });

  // Assert
  assert.throws(make, refused('../escape'));
  assert.deepEqual(await readdir(parent.path), []);
});

test('directorySync throws the error of a write that fails, and no folder is left', async () => {
  // Arrange
  await using parent = await new TemporaryFiles().directory('fs-parent-');

  // Act
  const make = () =>
    new TemporaryFiles().directorySync('fs-', {
      parent: parent.path,
      files: unwritable,
    });

  // Assert
  assert.throws(make, failedWrite);
  assert.deepEqual(await readdir(parent.path), []);
});

test('with an empty files record, the folder is empty', async () => {
  // Act
  await using folder = await new TemporaryFiles().directory('fs-', {
    files: {},
  });

  // Assert
  assert.deepEqual(await readdir(folder.path), []);
});

test('the disposal removes the folder with the files that files wrote', async () => {
  // Arrange
  const folder = await new TemporaryFiles().directory('fs-', {
    files: { 'deep/er/file.txt': 'x' },
  });

  // Act
  await folder[Symbol.asyncDispose]();

  // Assert
  await assert.rejects(readdir(folder.path), { code: 'ENOENT' });
});
