import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { FileStamp } from '@zukhruf/fs';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import { DataVersion, UnavailableError } from './index.ts';

// A database with one committed note, as its owner leaves it between runs.
function created(path: string) {
  using database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
    INSERT INTO notes (title) VALUES ('first');
  `);
}

// Another process that holds the database in SQLite's exclusive locking mode,
// as Chromium holds its History. It runs each line it reads as SQL. A process
// of its own, because SQLite does not lock out a second connection of the
// same process.
async function startOwner(path: string) {
  const source = `
    import { createInterface } from 'node:readline';
    import { DatabaseSync } from 'node:sqlite';
    const owner = new DatabaseSync(${JSON.stringify(path)});
    owner.exec('PRAGMA locking_mode = EXCLUSIVE');
    owner.exec("INSERT INTO notes (title) VALUES ('held')");
    console.log('done');
    createInterface({ input: process.stdin }).on('line', (sql) => {
      owner.exec(sql);
      console.log('done');
    });
  `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { stdio: ['pipe', 'pipe', 'inherit'] },
  );
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout })[
    Symbol.asyncIterator
  ]();
  const done = async () => {
    const { value } = await lines.next();
    if (value !== 'done') throw new Error('The owner ended');
  };
  await done();
  const kill = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGKILL');
    await exited;
  };
  return {
    async run(sql: string) {
      child.stdin.write(`${sql}\n`);
      await done();
    },
    [Symbol.asyncDispose]: kill,
  };
}

test('an owner that holds the database locks out a plain version, and the version of an exclusive owner changes with each commit', async () => {
  await using dir = await new TemporaryFiles().directory('data-version-');
  const path = join(dir.path, 'History');
  created(path);
  await using owner = await startOwner(path);

  assert.throws(() => new DataVersion(path), { errcode: 5 });
  using version = DataVersion.ofExclusiveOwner(path);
  const before = version.current;

  await owner.run("INSERT INTO notes (title) VALUES ('second')");
  const second = version.current;
  await owner.run("INSERT INTO notes (title) VALUES ('third')");

  assert.ok(second > before);
  assert.ok(version.current > second);
});

test('the version of an exclusive owner stays the same while the owner commits nothing, also while its transaction writes the journal', async () => {
  await using dir = await new TemporaryFiles().directory('data-version-');
  const path = join(dir.path, 'History');
  created(path);
  await using owner = await startOwner(path);
  using version = DataVersion.ofExclusiveOwner(path);
  const before = version.current;

  await owner.run('SELECT count(*) FROM notes');
  const idle = version.current;
  const journal = FileStamp.readSync(`${path}-journal`);
  await owner.run("BEGIN; INSERT INTO notes (title) VALUES ('open')");

  assert.equal(idle, before);
  assert.ok(
    !FileStamp.readSync(`${path}-journal`).equals(journal),
    'The open transaction did not write the journal',
  );
  assert.equal(version.current, before);
});

test('a missing database of an exclusive owner is the UnavailableError of @zukhruf/sqlite-reader', async () => {
  await using dir = await new TemporaryFiles().directory('data-version-');
  const path = join(dir.path, 'missing', 'History');

  assert.throws(
    () => DataVersion.ofExclusiveOwner(path),
    (error: unknown) => {
      assert.ok(error instanceof UnavailableError);
      assert.equal(error.path, path);
      return true;
    },
  );
});

test('a database that moves away, or that the process may no longer see, is no change until a file is at the path again', async () => {
  await using dir = await new TemporaryFiles().directory('data-version-');
  const folder = join(dir.path, 'profile');
  await mkdir(folder);
  const path = join(folder, 'History');
  const aside = join(dir.path, 'History.aside');
  created(path);
  await using owner = await startOwner(path);
  using version = DataVersion.ofExclusiveOwner(path);
  const before = version.current;

  await rename(path, aside);
  const away = version.current;
  if (process.platform !== 'win32' && process.getuid?.() !== 0) {
    await chmod(folder, 0o000);
    try {
      assert.equal(version.current, before);
    } finally {
      await chmod(folder, 0o700);
    }
  }
  await rename(aside, path);
  await owner.run("INSERT INTO notes (title) VALUES ('back')");

  assert.equal(away, before);
  assert.ok(version.current > before);
});

test(
  'a database in a folder that the process may not search is the UnavailableError of @zukhruf/sqlite-reader',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async () => {
    await using dir = await new TemporaryFiles().directory('data-version-');
    const folder = join(dir.path, 'denied');
    await mkdir(folder);
    const path = join(folder, 'History');
    created(path);
    await chmod(folder, 0o000);
    try {
      assert.throws(
        () => DataVersion.ofExclusiveOwner(path),
        (error: unknown) => {
          assert.ok(error instanceof UnavailableError);
          assert.equal(error.path, path);
          return true;
        },
      );
    } finally {
      await chmod(folder, 0o700);
    }
  },
);
