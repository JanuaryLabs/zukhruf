import assert from 'node:assert/strict';
// The default export is the module object itself, which mock.method can patch;
// syncBuiltinESMExports then copies the patch to the named exports.
import fsPromises, {
  mkdtempDisposable,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, mock, test } from 'node:test';

import { createExclusive } from './create-exclusive.ts';

/** Makes every `link` fail with `code`, as a full or broken disk would. */
function failLink(code: string) {
  mock.method(fsPromises, 'link', async () => {
    throw Object.assign(new Error(`${code}: link failed`), {
      code,
      syscall: 'link',
    });
  });
  syncBuiltinESMExports();
  return {
    [Symbol.dispose]() {
      mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

describe('createExclusive', () => {
  test(
    'a link that fails for a reason other than an existing file rejects with that error and leaves no draft',
    { timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'job.lock');
      using _failing = failLink('EIO');

      // Act
      const creating = createExclusive(path, 'pid 4242');

      // Assert
      await assert.rejects(creating, { code: 'EIO' });
      assert.deepEqual(
        await readdir(directory.path),
        [],
        'A failed create must not leave its draft',
      );
    },
  );

  test(
    'no draft stays in the directory, whether the file was created or already there',
    { timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'job.lock');

      // Act
      const first = await createExclusive(path, 'pid 1');
      const second = await createExclusive(path, 'pid 2');

      // Assert
      assert.deepEqual([first, second], [true, false]);
      assert.deepEqual(await readdir(directory.path), ['job.lock']);
    },
  );

  test(
    'a file that is there already keeps its content, and the call returns false',
    { timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'job.lock');
      await writeFile(path, 'pid 1');

      // Act
      const created = await createExclusive(path, 'pid 2');

      // Assert
      assert.equal(created, false);
      assert.equal(await readFile(path, 'utf8'), 'pid 1');
    },
  );

  test(
    'an absent file is created with all of its content, and the call returns true',
    { timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'job.lock');
      const content = 'pid 4242\n'.repeat(1_000);

      // Act
      const created = await createExclusive(path, content);

      // Assert
      assert.equal(created, true);
      assert.equal(await readFile(path, 'utf8'), content);
    },
  );

  test(
    'of many callers that create one absent file at the same time, exactly one creates it',
    { timeout: 2_000 },
    async () => {
      // Arrange
      await using directory = await mkdtempDisposable(
        join(tmpdir(), 'zukhruf-fs-'),
      );
      const path = join(directory.path, 'job.lock');
      const callers = Array.from({ length: 8 }, (_, index) => `pid ${index}`);

      // Act
      const results = await Promise.all(
        callers.map((caller) => createExclusive(path, caller)),
      );

      // Assert
      const winners = callers.filter((_, index) => results[index]);
      assert.equal(
        winners.length,
        1,
        `One caller must create the file, got ${winners.join(', ')}`,
      );
      assert.equal(await readFile(path, 'utf8'), winners[0]);
      assert.deepEqual(await readdir(directory.path), ['job.lock']);
    },
  );
});
