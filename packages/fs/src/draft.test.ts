import assert from 'node:assert/strict';
import { mkdtempDisposable, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { atomicWrite } from './atomic-write.ts';
import { createExclusive } from './create-exclusive.ts';
import { draftSuffixLength } from './draft.ts';
import { durableWrite } from './durable-write.ts';

/** The longest file name that ext4, APFS, NTFS and tmpfs accept. */
const longestFileName = 255;

const writes = {
  atomicWrite,
  durableWrite,
  createExclusive,
} satisfies Record<string, (path: string, content: string) => Promise<unknown>>;

describe('The room for the name of a draft', () => {
  for (const [name, write] of Object.entries(writes)) {
    test(
      `${name} writes a file whose name leaves exactly draftSuffixLength characters of room`,
      { timeout: 2_000 },
      async () => {
        // Arrange
        await using directory = await mkdtempDisposable(
          join(tmpdir(), 'zukhruf-fs-'),
        );
        const longest = 'k'.repeat(longestFileName - draftSuffixLength);

        // Act
        await write(join(directory.path, longest), 'content');

        // Assert
        assert.deepEqual(await readdir(directory.path), [longest]);
      },
    );

    test(
      `${name} fails with ENAMETOOLONG for a name one character longer`,
      { timeout: 2_000 },
      async () => {
        // Arrange
        await using directory = await mkdtempDisposable(
          join(tmpdir(), 'zukhruf-fs-'),
        );
        const tooLong = 'k'.repeat(longestFileName - draftSuffixLength + 1);

        // Act
        const writing = write(join(directory.path, tooLong), 'content');

        // Assert
        await assert.rejects(writing, { code: 'ENAMETOOLONG' });
        assert.deepEqual(await readdir(directory.path), []);
      },
    );
  }
});
