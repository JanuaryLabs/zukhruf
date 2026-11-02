import assert from 'node:assert/strict';
import { chmod, mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { TemporaryFiles } from '@zukhruf/testing/fs';

import { FileStamp, FileStamps } from './index.ts';

// A whole second, which a double holds exactly, so a writer can give a file
// back the same write time to the nanosecond, as rsync -t and tar do.
const keptTime = 1_700_000_000;

test('a file that nobody writes keeps its stamp', async () => {
  await using directory = await new TemporaryFiles().directory('stamp-');
  const path = join(directory.path, 'store');
  await writeFile(path, 'content');

  const first = await FileStamp.read(path);
  const second = await FileStamp.read(path);
  const synchronous = FileStamp.readSync(path);

  assert.ok(first.equals(second));
  assert.ok(first.equals(synchronous));
});

test('each write changes the stamp, also when the writer keeps the size and gives back the write time', async () => {
  await using directory = await new TemporaryFiles().directory('stamp-');
  const path = join(directory.path, 'store');
  await writeFile(path, 'content-00');
  await utimes(path, keptTime, keptTime);
  let previous = await FileStamp.read(path);

  for (let write = 1; write <= 20; write++) {
    await writeFile(path, `content-${String(write).padStart(2, '0')}`);
    await utimes(path, keptTime, keptTime);
    const stamp = await FileStamp.read(path);
    const synchronous = FileStamp.readSync(path);

    assert.ok(!stamp.equals(previous), `write ${write} kept the stamp`);
    assert.ok(stamp.equals(synchronous));
    previous = stamp;
  }
});

test('a new file put over the path with the same size and write time changes the stamp', async () => {
  await using directory = await new TemporaryFiles().directory('stamp-');
  const path = join(directory.path, 'store');
  const draft = join(directory.path, 'store.draft');
  await writeFile(path, 'old');
  await utimes(path, keptTime, keptTime);
  const before = await FileStamp.read(path);

  await writeFile(draft, 'new');
  await utimes(draft, keptTime, keptTime);
  await rename(draft, path);

  assert.ok(!(await FileStamp.read(path)).equals(before));
});

test('a missing file has a stamp of its own, and its return and its removal change the stamp', async () => {
  await using directory = await new TemporaryFiles().directory('stamp-');
  const path = join(directory.path, 'store');

  const missing = await FileStamp.read(path);
  assert.equal(missing.modifiedAt, undefined);
  assert.ok(missing.equals(FileStamp.readSync(path)));

  await writeFile(path, 'content');
  await utimes(path, keptTime, keptTime);
  const present = await FileStamp.read(path);
  assert.ok(!present.equals(missing));
  assert.deepEqual(present.modifiedAt, new Date(keptTime * 1000));

  await rm(path);
  assert.ok((await FileStamp.read(path)).equals(missing));
});

test('a path through a file is missing', async () => {
  await using directory = await new TemporaryFiles().directory('stamp-');
  const file = join(directory.path, 'file');
  await writeFile(file, 'content');

  const stamp = await FileStamp.read(join(file, 'store'));
  const synchronous = FileStamp.readSync(join(file, 'store'));

  assert.equal(stamp.modifiedAt, undefined);
  assert.equal(synchronous.modifiedAt, undefined);
});

test(
  'a file in a folder that the process may not search throws, and does not read as missing',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async () => {
    await using directory = await new TemporaryFiles().directory('stamp-');
    const folder = join(directory.path, 'denied');
    await mkdir(folder);
    const path = join(folder, 'store');
    await writeFile(path, 'content');
    await chmod(folder, 0o000);
    try {
      await assert.rejects(FileStamp.read(path), { code: 'EACCES' });
      assert.throws(() => FileStamp.readSync(path), { code: 'EACCES' });
    } finally {
      await chmod(folder, 0o700);
    }
  },
);

test('the stamp of several files changes when any one of them changes, and a missing one is part of it', async () => {
  await using directory = await new TemporaryFiles().directory('stamp-');
  const database = join(directory.path, 'History');
  const journal = join(directory.path, 'History-journal');
  const later = join(directory.path, 'later');
  await writeFile(database, 'database');
  await writeFile(journal, 'journal');
  await utimes(journal, keptTime, keptTime);
  const before = await FileStamps.read([database, journal, later]);

  await writeFile(journal, 'JOURNAL');
  await utimes(journal, keptTime, keptTime);
  const written = await FileStamps.read([database, journal, later]);
  await writeFile(later, 'later');
  const appeared = FileStamps.readSync([database, journal, later]);

  assert.ok(!written.equals(before));
  assert.ok(!appeared.equals(written));
  assert.ok(appeared.equals(await FileStamps.read([database, journal, later])));
});

test('several files were last written when the newest of them was, and never when none is present', async () => {
  await using directory = await new TemporaryFiles().directory('stamp-');
  const older = join(directory.path, 'older');
  const newer = join(directory.path, 'newer');
  const missing = join(directory.path, 'missing');
  await writeFile(older, 'older');
  await writeFile(newer, 'newer');
  await utimes(older, keptTime, keptTime + 30);
  await utimes(newer, keptTime, keptTime + 60);

  const stamps = await FileStamps.read([missing, newer, older]);
  const none = FileStamps.readSync([missing]);

  assert.deepEqual(stamps.modifiedAt, new Date((keptTime + 60) * 1000));
  assert.equal(none.modifiedAt, undefined);
});
