import assert from 'node:assert/strict';
// The default export is the module object itself, which mock.method can patch;
// syncBuiltinESMExports then copies the patch to the named exports.
import fsPromises, { readFile, readdir, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { type TestContext, describe, test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { createExclusive } from './create-exclusive.ts';

/** Records each `link` with the content its source holds at that moment; every link still reaches the disk. */
function recordLinks(t: TestContext) {
  const links: { from: string; to: string; content: string }[] = [];
  const link = fsPromises.link;
  t.mock.method(fsPromises, 'link', async (from: string, to: string) => {
    links.push({ from, to, content: await readFile(from, 'utf8') });
    return link(from, to);
  });
  syncBuiltinESMExports();
  return {
    links,
    [Symbol.dispose]() {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

/** Makes every `link` fail with `code`, as a full or broken disk would. */
function failLink(t: TestContext, code: string) {
  t.mock.method(fsPromises, 'link', async () => {
    throw Object.assign(new Error(`${code}: link failed`), {
      code,
      syscall: 'link',
    });
  });
  syncBuiltinESMExports();
  return {
    [Symbol.dispose]() {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

/** Makes every `writeFile` put half of its content on the disk and then fail with `code`, as a disk that fills up halfway would. */
function failWriteHalfway(t: TestContext, code: string) {
  const failure = Object.assign(new Error(`${code}: write failed`), {
    code,
    syscall: 'write',
  });
  const write = fsPromises.writeFile;
  t.mock.method(
    fsPromises,
    'writeFile',
    async (path: string, content: string) => {
      await write(path, content.slice(0, content.length / 2));
      throw failure;
    },
  );
  syncBuiltinESMExports();
  return {
    failure,
    [Symbol.dispose]() {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    },
  };
}

describe('createExclusive', () => {
  for (const before of [undefined, 'pid 1']) {
    test(
      `a write of the draft that fails halfway rejects with that error, leaves no draft and ${before === undefined ? 'creates no file' : 'keeps the file that is there'}`,
      { timeout: 2_000 },
      async (t) => {
        // Arrange
        await using directory = await new TemporaryFiles().directory(
          'zukhruf-fs-',
        );
        const path = join(directory.path, 'job.lock');
        if (before !== undefined) await writeFile(path, before);
        using disk = failWriteHalfway(t, 'ENOSPC');

        // Act
        const creating = createExclusive(path, 'pid 4242\n'.repeat(1_000));

        // Assert
        await assert.rejects(creating, (error) => error === disk.failure);
        assert.deepEqual(
          await readdir(directory.path),
          before === undefined ? [] : ['job.lock'],
          'A failed create must not create the file nor leave its draft',
        );
        if (before !== undefined) {
          assert.equal(await readFile(path, 'utf8'), before);
        }
      },
    );
  }

  test(
    'a write of the draft that fails halfway rejects with that error, also when the draft cannot be removed',
    { timeout: 2_000 },
    async (t) => {
      // Arrange: a broken disk refuses the removal of the draft too.
      await using directory = await new TemporaryFiles().directory(
        'zukhruf-fs-',
      );
      const path = join(directory.path, 'job.lock');
      using disk = failWriteHalfway(t, 'EIO');
      t.mock.method(fsPromises, 'unlink', async () => {
        throw Object.assign(new Error('EIO: unlink failed'), {
          code: 'EIO',
          syscall: 'unlink',
        });
      });
      syncBuiltinESMExports();

      // Act
      const creating = createExclusive(path, 'pid 4242\n'.repeat(1_000));

      // Assert
      await assert.rejects(creating, (error) => error === disk.failure);
    },
  );

  test(
    'a link that fails for a reason other than an existing file rejects with that error and leaves no draft',
    { timeout: 2_000 },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory(
        'zukhruf-fs-',
      );
      const path = join(directory.path, 'job.lock');
      using _failing = failLink(t, 'EIO');

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
      await using directory = await new TemporaryFiles().directory(
        'zukhruf-fs-',
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
      await using directory = await new TemporaryFiles().directory(
        'zukhruf-fs-',
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
      await using directory = await new TemporaryFiles().directory(
        'zukhruf-fs-',
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
      await using directory = await new TemporaryFiles().directory(
        'zukhruf-fs-',
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

  test(
    'the file appears by a link of a draft that already holds all of the content, so a reader never sees it empty',
    { timeout: 2_000 },
    async (t) => {
      // Arrange
      await using directory = await new TemporaryFiles().directory(
        'zukhruf-fs-',
      );
      const path = join(directory.path, 'job.lock');
      const content = 'pid 4242\n'.repeat(1_000);
      using disk = recordLinks(t);

      // Act
      await createExclusive(path, content);

      // Assert
      assert.equal(disk.links.length, 1, 'The file must appear in one step');
      assert.equal(disk.links[0]?.to, path);
      assert.equal(
        disk.links[0]?.content,
        content,
        'The draft must hold all of the content before it appears at the path',
      );
    },
  );
});
