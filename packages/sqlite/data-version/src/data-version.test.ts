import assert from 'node:assert/strict';
import { renameSync, rmSync } from 'node:fs';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { ChangeWatcher } from '@zukhruf/async';
import * as sqliteOpen from '@zukhruf/sqlite-open';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import { DataVersion, UnavailableError } from './index.ts';

test('the version stays the same until the owner commits, then changes', async () => {
  await using dir = await new TemporaryFiles().directory('data-version-');
  const path = join(dir.path, 'source.sqlite');
  using owner = sqliteOpen.open(path);
  owner.exec(`
    CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
    INSERT INTO notes (title) VALUES ('first');
  `);
  using version = new DataVersion(path);
  const before = version.current;
  assert.equal(version.current, before);

  owner.exec("INSERT INTO notes (title) VALUES ('second')");

  assert.notEqual(version.current, before);
});

test('a change watcher over the version sees a commit of the owner as changed', async () => {
  await using dir = await new TemporaryFiles().directory('data-version-');
  const path = join(dir.path, 'source.sqlite');
  using owner = sqliteOpen.open(path);
  owner.exec(`
    CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
    INSERT INTO notes (title) VALUES ('first');
  `);
  using version = new DataVersion(path);
  const stop = new AbortController();
  const checks = new ChangeWatcher([version], {
    interval: 5,
    timeout: 5,
    clock: globalThis,
  }).watch(stop.signal);
  try {
    await checks.next();

    owner.exec("INSERT INTO notes (title) VALUES ('second')");
    const check = await checks.next();

    assert.deepEqual(check.value?.get(version), { state: 'changed' });
  } finally {
    stop.abort();
    await checks.return();
  }
});

test('a change watcher over the version sees no commit as unchanged', async () => {
  await using dir = await new TemporaryFiles().directory('data-version-');
  const path = join(dir.path, 'source.sqlite');
  using owner = sqliteOpen.open(path);
  owner.exec(`
    CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
    INSERT INTO notes (title) VALUES ('first');
  `);
  using version = new DataVersion(path);
  const stop = new AbortController();
  const checks = new ChangeWatcher([version], {
    interval: 5,
    timeout: 5,
    clock: globalThis,
  }).watch(stop.signal);
  try {
    await checks.next();

    const check = await checks.next();

    assert.deepEqual(check.value?.get(version), { state: 'unchanged' });
  } finally {
    stop.abort();
    await checks.return();
  }
});

// The owner's connection to a new database at the path, with one row.
function created(path: string, journal: 'WAL' | 'DELETE'): DatabaseSync {
  const owner = sqliteOpen.open(path, {
    journal: new sqliteOpen.UnchangedJournal(),
  });
  owner.exec(`
    PRAGMA journal_mode = ${journal};
    CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
    INSERT INTO notes (title) VALUES ('first');
  `);
  return owner;
}

test('a new file renamed over the path changes the version, and its commits change it again', async () => {
  await using dir = await new TemporaryFiles().directory('data-version-');
  const path = join(dir.path, 'source.sqlite');
  created(path, 'DELETE').close();
  using version = new DataVersion(path);
  const before = version.current;
  const replacement = join(dir.path, 'replacement.sqlite');
  created(replacement, 'DELETE').close();

  renameSync(replacement, path);
  const replaced = version.current;
  using owner = sqliteOpen.open(path, {
    journal: new sqliteOpen.RollbackJournal(),
  });
  owner.exec("INSERT INTO notes (title) VALUES ('second')");

  assert.notEqual(replaced, before, 'the replaced file is not a change');
  assert.notEqual(
    version.current,
    replaced,
    'a commit to the new file is not a change',
  );
});

test('a WAL database deleted with its WAL and shared-memory index and created again changes the version, and its commits change it again', async () => {
  await using dir = await new TemporaryFiles().directory('data-version-');
  const path = join(dir.path, 'source.sqlite');
  const first = created(path, 'WAL');
  using version = new DataVersion(path);
  const before = version.current;
  first.close();

  for (const suffix of ['', '-wal', '-shm'])
    rmSync(`${path}${suffix}`, { force: true });
  using owner = created(path, 'WAL');
  const recreated = version.current;
  owner.exec("INSERT INTO notes (title) VALUES ('second')");

  assert.notEqual(recreated, before, 'the created file is not a change');
  assert.notEqual(
    version.current,
    recreated,
    'a commit to the new file is not a change',
  );
});

test('a missing path is no change until a file is created there again', async () => {
  await using dir = await new TemporaryFiles().directory('data-version-');
  const path = join(dir.path, 'source.sqlite');
  const first = created(path, 'WAL');
  using version = new DataVersion(path);
  const before = version.current;
  first.close();

  for (const suffix of ['', '-wal', '-shm'])
    rmSync(`${path}${suffix}`, { force: true });
  const missing = version.current;
  using _owner = created(path, 'WAL');

  assert.equal(missing, before, 'the missing path is a change');
  assert.notEqual(version.current, missing, 'the created file is not a change');
});

test('a missing file is the UnavailableError of @zukhruf/sqlite-open', async () => {
  await using dir = await new TemporaryFiles().directory('data-version-');
  const missing = join(dir.path, 'missing', 'source.sqlite');

  assert.throws(
    () => new DataVersion(missing),
    (error: unknown) => {
      assert.equal(UnavailableError, sqliteOpen.UnavailableError);
      assert.ok(error instanceof sqliteOpen.UnavailableError);
      assert.equal(error.path, missing);
      assert.ok(error.cause instanceof Error && 'errcode' in error.cause);
      assert.equal(error.cause.errcode, 14);
      return true;
    },
  );
});

test(
  'a file in a folder the system denies is an UnavailableError',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using dir = await new TemporaryFiles().directory('data-version-');
    const folder = join(dir.path, 'denied');
    await mkdir(folder);
    const path = join(folder, 'source.sqlite');
    sqliteOpen.open(path).close();
    await chmod(folder, 0o000);
    try {
      assert.throws(
        () => new DataVersion(path),
        (error: unknown) => {
          assert.ok(error instanceof UnavailableError);
          assert.equal(error.path, path);
          assert.ok(error.cause instanceof Error && 'errcode' in error.cause);
          assert.equal(error.cause.errcode, 14);
          return true;
        },
      );
    } finally {
      await chmod(folder, 0o700);
    }
  },
);

test(
  'a folder whose mode comes to deny this process is no change',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using dir = await new TemporaryFiles().directory('data-version-');
    const folder = join(dir.path, 'denied');
    await mkdir(folder);
    const path = join(folder, 'source.sqlite');
    created(path, 'DELETE').close();
    using version = new DataVersion(path);
    const before = version.current;
    await chmod(folder, 0o000);
    try {
      const denied = version.current;

      assert.equal(denied, before);
    } finally {
      await chmod(folder, 0o700);
    }
  },
);

test(
  'a file that replaces the path and that the system denies makes current an UnavailableError',
  {
    // chmod denies nothing on Windows, and nothing to root.
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    await using dir = await new TemporaryFiles().directory('data-version-');
    const path = join(dir.path, 'source.sqlite');
    created(path, 'DELETE').close();
    using version = new DataVersion(path);
    const replacement = join(dir.path, 'replacement.sqlite');
    created(replacement, 'DELETE').close();
    await chmod(replacement, 0o000);

    renameSync(replacement, path);

    assert.throws(
      () => version.current,
      (error: unknown) => {
        assert.ok(error instanceof UnavailableError);
        assert.equal(error.path, path);
        assert.ok(error.cause instanceof Error && 'errcode' in error.cause);
        assert.equal(error.cause.errcode, 14);
        return true;
      },
    );
  },
);
