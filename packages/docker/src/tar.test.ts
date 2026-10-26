import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { link, mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { tarEntries } from './tar-reader.ts';
import { type TarWriterEntry, tarArchive } from './tar-writer.ts';
import { scratchDirectory } from './testing/scratch-directory.ts';

/**
 * Runs the tar program of this machine with `input`, if any, on its standard
 * input, and gives its standard output. With no input nothing is written: tar
 * -c never reads its standard input, and a write after it exits fails with
 * EPIPE on Linux.
 */
function systemTar(args: string[], input?: Uint8Array): Buffer {
  const result = spawnSync('tar', args, {
    input,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `tar ${args.join(' ')}`);
  return result.stdout;
}

/** The bytes in chunks of `size`, so that headers and data cross chunk borders. */
async function* inChunks(
  bytes: Uint8Array,
  size: number,
): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

const LONG = `${'a'.repeat(60)}/${'b'.repeat(60)}.txt`;
const LONGER = `${Array.from({ length: 6 }, (_, index) => String(index).repeat(50)).join('/')}/${'c'.repeat(40)}.txt`;

/** A name whose last part is longer than 100 bytes: no ustar split fits, so the tar program writes PAX or a GNU long name. */
const UNSPLITTABLE = `dir/${'d'.repeat(120)}.txt`;

describe('the tar archives of the package', () => {
  test('an archive of the writer has a file, a directory and paths longer than 100 and 255 characters, and the reader and the tar program of this machine read them back', async () => {
    // Arrange
    const data = new Uint8Array([0, 1, 2, 255, 10]);
    const longFiles = [LONG, LONGER].map((path): TarWriterEntry => ({
      path,
      type: 'file',
      data: new TextEncoder().encode(path),
      mode: 0o644,
      uid: 0,
      gid: 0,
      mtime: 1_700_000_002,
    }));
    const archive = tarArchive([
      {
        path: 'dir',
        type: 'directory',
        data: new Uint8Array(0),
        mode: 0o700,
        uid: 99,
        gid: 98,
        mtime: 1_700_000_000,
      },
      {
        path: 'dir/blob.bin',
        type: 'file',
        data,
        mode: 0o640,
        uid: 1234,
        gid: 4321,
        mtime: 1_700_000_001,
      },
      ...longFiles,
    ]);

    // Act
    const entries = await Array.fromAsync(tarEntries(inChunks(archive, 7)));
    const listed = systemTar(['-tf', '-'], archive)
      .toString('utf8')
      .split('\n')
      .filter(Boolean);

    // Assert
    assert.equal(archive.byteLength % 512, 0);
    assert.ok(
      archive.subarray(-1024).every((byte) => byte === 0),
      'two zero blocks end the archive',
    );
    assert.deepEqual(
      entries.map(({ path, type, mode, uid, gid, mtime, linkTarget }) => ({
        path,
        type,
        mode,
        uid,
        gid,
        mtime,
        linkTarget,
      })),
      [
        {
          path: 'dir',
          type: 'directory',
          mode: 0o700,
          uid: 99,
          gid: 98,
          mtime: 1_700_000_000,
          linkTarget: '',
        },
        {
          path: 'dir/blob.bin',
          type: 'file',
          mode: 0o640,
          uid: 1234,
          gid: 4321,
          mtime: 1_700_000_001,
          linkTarget: '',
        },
        ...[LONG, LONGER].map((path) => ({
          path,
          type: 'file',
          mode: 0o644,
          uid: 0,
          gid: 0,
          mtime: 1_700_000_002,
          linkTarget: '',
        })),
      ],
    );
    assert.deepEqual(new Uint8Array(entries[1]?.data ?? []), data);
    assert.equal(new TextDecoder().decode(entries[3]?.data), LONGER);
    assert.deepEqual(listed, ['dir/', 'dir/blob.bin', LONG, LONGER]);
  });

  test(
    'the reader reads an archive of the tar program of this machine: a long name, a symlink and a hard link',
    {
      skip:
        process.platform === 'win32'
          ? 'a symlink needs a privilege on Windows'
          : false,
    },
    async () => {
      // Arrange
      await using scratch = await scratchDirectory();
      const tree = join(scratch.path, 'tree');
      await mkdir(join(tree, ...UNSPLITTABLE.split('/').slice(0, -1)), {
        recursive: true,
      });
      await writeFile(join(tree, UNSPLITTABLE), 'long\n');
      await writeFile(join(tree, 'target.txt'), 'target\n');
      await symlink('target.txt', join(tree, 'soft'));
      await link(join(tree, 'target.txt'), join(tree, 'hard'));
      const archive = systemTar(['-cf', '-', '-C', tree, '.']);

      // Act
      const entries = await Array.fromAsync(tarEntries(inChunks(archive, 100)));

      // Assert
      const byPath = new Map(
        entries.map((entry) => [entry.path.replace(/^\.\//, ''), entry]),
      );
      assert.equal(
        new TextDecoder().decode(byPath.get(UNSPLITTABLE)?.data),
        'long\n',
        [...byPath.keys()].join('\n'),
      );
      assert.equal(byPath.get('soft')?.type, 'symlink');
      assert.equal(byPath.get('soft')?.linkTarget, 'target.txt');
      const hardLinked = [byPath.get('hard'), byPath.get('target.txt')];
      assert.deepEqual(hardLinked.map((entry) => entry?.type).toSorted(), [
        'file',
        'link',
      ]);
    },
  );
});
