import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { hash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';

import { RollbackJournal, open } from '@zukhruf/sqlite-open';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  DatabaseChangingError,
  MissingColumnsError,
  Snapshot,
  UnavailableError,
} from './index.ts';

// A database with two committed visits, as its owner leaves it between runs.
// The owner keeps a rollback journal, as Chromium keeps its History.
function created(path: string) {
  using database = open(path, { journal: new RollbackJournal() });
  database.exec(`
    CREATE TABLE visits (id INTEGER PRIMARY KEY, url TEXT);
    INSERT INTO visits (url) VALUES ('one'), ('two');
  `);
}

// The owner commits a third visit and 3,000 pages, then, in a transaction it
// never commits, rewrites every page and adds many visits. Its cache holds one
// page, so SQLite spills the uncommitted pages into the database file, the
// rewritten pages too, and keeps the committed ones in a hot journal.
const spillsUncommitted = `
  owner.exec('PRAGMA cache_size = 1');
  owner.exec("INSERT INTO visits (url) VALUES ('three')");
  owner.exec('CREATE TABLE pages (id INTEGER PRIMARY KEY, body TEXT)');
  owner.exec('BEGIN');
  const page = owner.prepare('INSERT INTO pages (body) VALUES (?)');
  for (let row = 0; row < 3000; row++) page.run('committed ' + 'x'.repeat(200));
  owner.exec('COMMIT');
  owner.exec('BEGIN');
  owner.exec("UPDATE pages SET body = 'uncommitted'");
  const insert = owner.prepare('INSERT INTO visits (url) VALUES (?)');
  for (let row = 0; row < 5000; row++) insert.run('uncommitted ' + 'x'.repeat(500));
`;

// The pages that the snapshot reads as the owner committed them.
const committedPages = (snapshot: Snapshot) =>
  snapshot.all(
    "SELECT count(*) AS pages FROM pages WHERE body LIKE 'committed %'",
  )[0]?.pages;

// Another process that holds the database in SQLite's exclusive locking mode,
// as Chromium holds its History, after it runs work. A process of its own,
// because SQLite does not lock out a second connection of the same process.
async function startOwner(path: string, work: string) {
  const source = `
    import { DatabaseSync } from 'node:sqlite';
    const owner = new DatabaseSync(${JSON.stringify(path)});
    owner.exec('PRAGMA locking_mode = EXCLUSIVE');
    ${work}
    console.log('holding');
    setInterval(() => owner, 1000);
  `;
  const child = spawn(
    process.execPath,
    ['--input-type=module', '--eval', source],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const exited = once(child, 'exit');
  let holding = false;
  for await (const line of createInterface({ input: child.stdout }))
    if (line === 'holding') {
      holding = true;
      break;
    }
  if (!holding) throw new Error('The owner ended before it held the database');
  const kill = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGKILL');
    await exited;
  };
  return { kill, [Symbol.asyncDispose]: kill };
}

const digest = async (path: string) => hash('sha256', await readFile(path));

// The copies in the temporary folder. Another process that takes a copy at
// the same moment would show here too.
const copies = async () =>
  new Set(
    (await readdir(tmpdir())).filter((name) =>
      name.startsWith('zukhruf-snapshot-'),
    ),
  );

const urls = (snapshot: Snapshot) =>
  snapshot.all('SELECT url FROM visits ORDER BY id').map(({ url }) => url);

test('a hot journal that a dead owner left stays as it is, and the snapshot reads the committed rows', async () => {
  await using dir = await new TemporaryFiles().directory('exclusive-');
  const path = join(dir.path, 'History');
  created(path);
  {
    await using owner = await startOwner(path, spillsUncommitted);
    await owner.kill();
  }
  const database = await digest(path);
  const journal = await digest(`${path}-journal`);

  {
    using snapshot = await Snapshot.ofExclusiveOwner(path);

    assert.deepEqual(urls(snapshot), ['one', 'two', 'three']);
    assert.equal(committedPages(snapshot), 3000);
  }
  assert.equal(await digest(path), database);
  assert.equal(await digest(`${path}-journal`), journal);
});

test('an owner that holds the database locks out a plain snapshot, and a snapshot of an exclusive owner reads its commits', async () => {
  await using dir = await new TemporaryFiles().directory('exclusive-');
  const path = join(dir.path, 'History');
  created(path);
  await using _owner = await startOwner(
    path,
    `owner.exec("INSERT INTO visits (url) VALUES ('three')");`,
  );

  assert.throws(() => new Snapshot(path), { errcode: 5 });
  using snapshot = await Snapshot.ofExclusiveOwner(path);

  assert.deepEqual(urls(snapshot), ['one', 'two', 'three']);
});

test('a transaction that the owner has not committed is not read, also when its pages are in the database file', async () => {
  await using dir = await new TemporaryFiles().directory('exclusive-');
  const path = join(dir.path, 'History');
  created(path);
  await using _owner = await startOwner(path, spillsUncommitted);
  assert.ok(
    (await stat(path)).size > 1_000_000,
    'The owner kept its uncommitted pages out of the database file',
  );

  using snapshot = await Snapshot.ofExclusiveOwner(path);

  assert.deepEqual(urls(snapshot), ['one', 'two', 'three']);
  assert.equal(committedPages(snapshot), 3000);
  assert.equal(
    snapshot.all('PRAGMA integrity_check')[0]?.integrity_check,
    'ok',
  );
});

test('while the owner commits now and then, each snapshot holds whole commits', async () => {
  await using dir = await new TemporaryFiles().directory('exclusive-');
  const path = join(dir.path, 'History');
  created(path);
  await using _owner = await startOwner(
    path,
    `owner.exec('CREATE TABLE pages (id INTEGER PRIMARY KEY)');
    owner.exec('INSERT INTO pages DEFAULT VALUES; INSERT INTO pages DEFAULT VALUES');
    setInterval(() => {
      owner.exec('BEGIN');
      owner.exec("INSERT INTO visits (url) VALUES ('visit')");
      owner.exec('INSERT INTO pages DEFAULT VALUES');
      owner.exec('COMMIT');
    }, 3);`,
  );

  let read = 0;
  for (let snapshots = 0; snapshots < 50; snapshots++) {
    let snapshot: Snapshot;
    try {
      snapshot = await Snapshot.ofExclusiveOwner(path);
    } catch (error) {
      if (error instanceof DatabaseChangingError) continue;
      throw error;
    }
    using _snapshot = snapshot;
    const [counts] = snapshot.all(
      'SELECT (SELECT count(*) FROM visits) AS visits, (SELECT count(*) FROM pages) AS pages',
    );
    assert.equal(counts?.visits, counts?.pages);
    read++;
  }

  assert.ok(read > 0, 'No snapshot was read');
});

// The owner never stops on its own, but the system still pauses it now and
// then, and a copy in a pause holds one whole commit. So each snapshot either
// reads one commit or fails with DatabaseChangingError; which one is up to
// the system.
test('while the owner commits without end, each snapshot reads one commit or fails with DatabaseChangingError, and leaves no copy', async () => {
  await using dir = await new TemporaryFiles().directory('exclusive-');
  const path = join(dir.path, 'History');
  created(path);
  await using _owner = await startOwner(
    path,
    // It says that it holds the database with a write that blocks, then
    // commits the visit count as the title of one visit, without end.
    `owner.exec('PRAGMA synchronous = OFF');
    owner.exec('CREATE TABLE commits (n INTEGER)');
    owner.exec("BEGIN; INSERT INTO commits VALUES (0); UPDATE visits SET url = '0' WHERE id = 1; COMMIT");
    const { writeSync } = await import('node:fs');
    writeSync(1, 'holding\\n');
    for (let n = 1; ; n++) {
      owner.exec('BEGIN');
      owner.exec("UPDATE visits SET url = '" + n + "' WHERE id = 1");
      owner.exec('UPDATE commits SET n = ' + n);
      owner.exec('COMMIT');
    }`,
  );
  const before = await copies();

  for (let snapshots = 0; snapshots < 30; snapshots++) {
    let snapshot: Snapshot;
    try {
      snapshot = await Snapshot.ofExclusiveOwner(path);
    } catch (error) {
      assert.ok(error instanceof DatabaseChangingError);
      assert.equal(error.path, path);
      continue;
    }
    using _snapshot = snapshot;
    const [row] = snapshot.all(
      'SELECT (SELECT url FROM visits WHERE id = 1) AS url, (SELECT n FROM commits) AS n',
    );
    assert.equal(row?.url, String(row?.n));
  }

  assert.deepEqual(
    [...(await copies())].filter((name) => !before.has(name)),
    [],
  );
});

test('a missing database is the UnavailableError of @zukhruf/sqlite-open, and leaves no copy', async () => {
  await using dir = await new TemporaryFiles().directory('exclusive-');
  const path = join(dir.path, 'missing', 'History');
  const before = await copies();

  await assert.rejects(Snapshot.ofExclusiveOwner(path), (error: unknown) => {
    assert.ok(error instanceof UnavailableError);
    assert.equal(error.path, path);
    return true;
  });
  assert.deepEqual(
    [...(await copies())].filter((name) => !before.has(name)),
    [],
  );
});

test('a layout without a required column names the database of the owner, and the snapshot removes its copy', async () => {
  await using dir = await new TemporaryFiles().directory('exclusive-');
  const path = join(dir.path, 'History');
  created(path);
  const before = await copies();
  const snapshot = await Snapshot.ofExclusiveOwner(path);

  assert.throws(
    () => snapshot.requireColumns({ visits: ['url', 'visit_time'] }),
    (error: unknown) => {
      assert.ok(error instanceof MissingColumnsError);
      assert.equal(error.path, path);
      assert.deepEqual(error.missing, ['visits.visit_time']);
      return true;
    },
  );
  assert.deepEqual(
    [...(await copies())].filter((name) => !before.has(name)),
    [],
  );
});

test('a disposed snapshot of an exclusive owner leaves no copy', async () => {
  await using dir = await new TemporaryFiles().directory('exclusive-');
  const path = join(dir.path, 'History');
  created(path);
  const before = await copies();

  {
    using snapshot = await Snapshot.ofExclusiveOwner(path);
    assert.deepEqual(urls(snapshot), ['one', 'two']);
    assert.equal(
      [...(await copies())].filter((name) => !before.has(name)).length,
      1,
    );
  }

  assert.deepEqual(
    [...(await copies())].filter((name) => !before.has(name)),
    [],
  );
});

test(
  'a database in a folder that the process may not search is the UnavailableError of @zukhruf/sqlite-open, and leaves no copy',
  { skip: process.platform === 'win32' || process.getuid?.() === 0 },
  async () => {
    await using dir = await new TemporaryFiles().directory('exclusive-');
    const folder = join(dir.path, 'denied');
    await mkdir(folder);
    const path = join(folder, 'History');
    created(path);
    await chmod(folder, 0o000);
    const before = await copies();
    try {
      await assert.rejects(
        Snapshot.ofExclusiveOwner(path),
        (error: unknown) => {
          assert.ok(error instanceof UnavailableError);
          assert.equal(error.path, path);
          return true;
        },
      );
    } finally {
      await chmod(folder, 0o700);
    }
    assert.deepEqual(
      [...(await copies())].filter((name) => !before.has(name)),
      [],
    );
  },
);
