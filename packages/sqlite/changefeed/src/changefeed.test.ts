import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { poll } from '@zukhruf/async';
import * as reader from '@zukhruf/sqlite-reader';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  type ChangeEvent,
  Changefeed,
  JournalModeError,
  UnavailableError,
} from './index.ts';

// The owner's connection to a new WAL database at the path.
function owned(path: string, sql: string): DatabaseSync {
  const owner = new DatabaseSync(path);
  owner.exec(`PRAGMA journal_mode = WAL; ${sql}`);
  return owner;
}

// A watch that gives no batch fails here, naming the batch it waited for,
// and not at the timeout of the runner.
async function within<T>(promise: Promise<T>, expected: string): Promise<T> {
  const timeout = AbortSignal.timeout(5000);
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timeout.addEventListener('abort', () => {
        reject(new Error(`no ${expected} within 5 s`));
      });
    }),
  ]);
}

// The next batch of a watch, which saves the batch before it.
async function nextBatch(
  batches: AsyncGenerator<ChangeEvent[], void, undefined>,
  expected: string,
): Promise<ChangeEvent[]> {
  const next = await within(batches.next(), `batch with ${expected}`);
  assert.ok(!next.done, 'the watch ended');
  return next.value;
}

// The events of a batch by table. The feed gives no order across tables.
function byTable(batch: ChangeEvent[]) {
  return { ...Object.groupBy(batch, (event) => event.table) };
}

// Polls the fact until it is true, and fails naming it after 5 s.
async function until(fact: () => boolean, expected: string): Promise<void> {
  try {
    await poll(async () => (fact() ? true : undefined), {
      interval: 5,
      signal: AbortSignal.timeout(5000),
    });
  } catch (cause) {
    throw new Error(`no ${expected} within 5 s`, { cause });
  }
}

// Whether the promise settled, read at once.
function settled(promise: Promise<unknown>): () => boolean {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  return () => done;
}

test('the first run of a durable feed reads each row of each table, keyed by the identity SQLite enforces, and skips views, virtual, shadow and internal tables', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using _owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT);
     INSERT INTO notes (title) VALUES ('Plan');
     CREATE TABLE codes (code TEXT PRIMARY KEY, label TEXT);
     INSERT INTO codes VALUES (NULL, 'a'), (NULL, 'b');
     CREATE TABLE pairs (a TEXT NOT NULL, b INTEGER NOT NULL, n INTEGER, PRIMARY KEY (b, a));
     INSERT INTO pairs VALUES ('x', 1, 10);
     CREATE TABLE files (hash BLOB PRIMARY KEY, body BLOB) WITHOUT ROWID;
     INSERT INTO files VALUES (x'0102', x'ff00');
     CREATE TABLE tags (note_id INTEGER, tag TEXT);
     INSERT INTO tags VALUES (1, 'q4');
     CREATE VIEW titles AS SELECT title FROM notes;
     CREATE VIRTUAL TABLE notes_fts USING fts5(body);
     INSERT INTO notes_fts VALUES ('searchable');
     ANALYZE;`,
  );
  using feed = new Changefeed(path, join(dir.path, 'position.sqlite'));
  const stop = new AbortController();

  const batch = await nextBatch(
    feed.watch({ interval: 5, signal: stop.signal }),
    'the reads of each table',
  );
  stop.abort();

  assert.deepEqual(byTable(batch), {
    codes: [
      {
        table: 'codes',
        op: 'read',
        key: { rowid: 1 },
        after: { code: null, label: 'a' },
      },
      {
        table: 'codes',
        op: 'read',
        key: { rowid: 2 },
        after: { code: null, label: 'b' },
      },
    ],
    files: [
      {
        table: 'files',
        op: 'read',
        key: { hash: new Uint8Array([1, 2]) },
        after: { hash: new Uint8Array([1, 2]), body: new Uint8Array([255, 0]) },
      },
    ],
    notes: [
      {
        table: 'notes',
        op: 'read',
        key: { id: 1 },
        after: { id: 1, title: 'Plan' },
      },
    ],
    pairs: [
      {
        table: 'pairs',
        op: 'read',
        key: { b: 1, a: 'x' },
        after: { a: 'x', b: 1, n: 10 },
      },
    ],
    tags: [
      {
        table: 'tags',
        op: 'read',
        key: { rowid: 1 },
        after: { note_id: 1, tag: 'q4' },
      },
    ],
  });
  assert.deepEqual(
    batch.flatMap((event) =>
      event.table === 'pairs' && event.op === 'read'
        ? [Object.keys(event.key)]
        : [],
    ),
    [['b', 'a']],
    'the key columns are in the order of the primary key',
  );
  for (const event of batch)
    if (event.op === 'read')
      assert.equal(Object.getPrototypeOf(event.after), Object.prototype);
});

test('a durable feed goes on from its saved batch: a new run gives only what the owner changed while it was stopped', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  const position = join(dir.path, 'position.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a'), (2, 'b'), (3, 'c');`,
  );
  {
    using feed = new Changefeed(path, position);
    const stop = new AbortController();
    const batches = feed.watch({ interval: 5, signal: stop.signal });
    await nextBatch(batches, 'the reads of notes');
    const next = batches.next();
    stop.abort(new Error('stopped'));
    await assert.rejects(next, /stopped/);
  }
  owner.exec(`INSERT INTO notes VALUES (4, 'd');
    UPDATE notes SET title = 'B' WHERE id = 2;
    DELETE FROM notes WHERE id = 3;`);

  const resumed = await (async () => {
    using feed = new Changefeed(path, position);
    const stop = new AbortController();
    const batches = feed.watch({ interval: 5, signal: stop.signal });
    const batch = await nextBatch(batches, 'the changes while stopped');
    const next = batches.next();
    stop.abort(new Error('stopped'));
    await assert.rejects(next, /stopped/);
    return batch;
  })();
  owner.exec('DELETE FROM notes WHERE id = 4');
  using feed = new Changefeed(path, position);
  const stop = new AbortController();
  const last = await nextBatch(
    feed.watch({ interval: 5, signal: stop.signal }),
    'the delete of note 4',
  );
  stop.abort();

  assert.deepEqual(resumed, [
    {
      table: 'notes',
      op: 'update',
      key: { id: 2 },
      after: { id: 2, title: 'B' },
    },
    {
      table: 'notes',
      op: 'insert',
      key: { id: 4 },
      after: { id: 4, title: 'd' },
    },
    { table: 'notes', op: 'delete', key: { id: 3 } },
  ]);
  assert.deepEqual(last, [{ table: 'notes', op: 'delete', key: { id: 4 } }]);
});

test('a batch that the loop leaves with break is given again at the next run', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  const position = join(dir.path, 'position.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  {
    using feed = new Changefeed(path, position);
    const batches = feed.watch({
      interval: 5,
      signal: new AbortController().signal,
    });
    await nextBatch(batches, 'the read of note 1');
    owner.exec("INSERT INTO notes VALUES (2, 'b')");
    await nextBatch(batches, 'the insert of note 2');
    await batches.return();
  }

  using feed = new Changefeed(path, position);
  const stop = new AbortController();
  const batch = await nextBatch(
    feed.watch({ interval: 5, signal: stop.signal }),
    'the insert of note 2 again',
  );
  stop.abort();

  assert.deepEqual(batch, [
    {
      table: 'notes',
      op: 'insert',
      key: { id: 2 },
      after: { id: 2, title: 'b' },
    },
  ]);
});

test('an observing feed gives no reads, then only the changes after it started', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a'), (2, 'b');`,
  );
  using feed = new Changefeed(path);
  const stop = new AbortController();
  const batches = feed.watch({ interval: 5, signal: stop.signal });

  const first = batches.next();
  // The baseline pass runs in microtasks, with no I/O but node:sqlite's
  // synchronous calls, so it ends before an immediate runs.
  await setImmediate();
  owner.exec(
    "UPDATE notes SET title = 'A' WHERE id = 1; DELETE FROM notes WHERE id = 2",
  );
  const batch = await first;
  stop.abort();

  assert.deepEqual(batch, {
    done: false,
    value: [
      {
        table: 'notes',
        op: 'update',
        key: { id: 1 },
        after: { id: 1, title: 'A' },
      },
      { table: 'notes', op: 'delete', key: { id: 2 } },
    ],
  });
});

test('a new table gives reads, an empty table it saw gives inserts, a dropped table a truncate, and a table with other key columns a truncate and then reads', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE drafts (id INTEGER PRIMARY KEY, body TEXT);
     INSERT INTO drafts VALUES (1, 'draft');
     CREATE TABLE labels (name TEXT, color TEXT);
     INSERT INTO labels VALUES ('red', 'f00');
     CREATE TABLE archive (id INTEGER PRIMARY KEY);`,
  );
  using feed = new Changefeed(path, join(dir.path, 'position.sqlite'));
  const stop = new AbortController();
  const batches = feed.watch({ interval: 5, signal: stop.signal });
  await nextBatch(batches, 'the first reads');

  owner.exec(`DROP TABLE drafts;
    CREATE TABLE folders (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO folders VALUES (7, 'Work');
    ALTER TABLE labels RENAME TO old_labels;
    CREATE TABLE labels (name TEXT PRIMARY KEY NOT NULL, color TEXT);
    INSERT INTO labels SELECT * FROM old_labels;
    DROP TABLE old_labels;
    INSERT INTO archive VALUES (1);`);
  const batch = await nextBatch(batches, 'the schema changes');
  owner.exec('INSERT INTO archive VALUES (2)');
  const after = await nextBatch(batches, 'the insert of archive 2');
  stop.abort();

  assert.deepEqual(byTable(batch), {
    archive: [
      { table: 'archive', op: 'insert', key: { id: 1 }, after: { id: 1 } },
    ],
    folders: [
      {
        table: 'folders',
        op: 'read',
        key: { id: 7 },
        after: { id: 7, name: 'Work' },
      },
    ],
    labels: [
      { table: 'labels', op: 'truncate' },
      {
        table: 'labels',
        op: 'read',
        key: { name: 'red' },
        after: { name: 'red', color: 'f00' },
      },
    ],
    drafts: [{ table: 'drafts', op: 'truncate' }],
  });
  assert.deepEqual(
    batch.filter((event) => event.table === 'labels').map(({ op }) => op),
    ['truncate', 'read'],
    'the truncate of labels comes before its reads',
  );
  assert.deepEqual(
    after,
    [{ table: 'archive', op: 'insert', key: { id: 2 }, after: { id: 2 } }],
    'a dropped table leaves the position',
  );
});

test('an observing feed gives the truncate of a dropped table once', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE drafts (id INTEGER PRIMARY KEY, body TEXT);
     INSERT INTO drafts VALUES (1, 'draft');
     CREATE TABLE archive (id INTEGER PRIMARY KEY);`,
  );
  using feed = new Changefeed(path);
  const stop = new AbortController();
  const batches = feed.watch({ interval: 5, signal: stop.signal });
  const first = batches.next();
  const firstSettled = settled(first);
  // The baseline takes no change, so the owner changes archive until a
  // pass after the baseline gives a batch.
  await until(() => {
    if (firstSettled()) return true;
    owner.exec('INSERT INTO archive DEFAULT VALUES');
    return false;
  }, 'batch after the baseline');
  await first;

  owner.exec('DROP TABLE drafts');
  const dropped = await nextBatch(batches, 'the truncate of drafts');
  owner.exec('INSERT INTO archive VALUES (1000)');
  const after = await nextBatch(batches, 'the insert of archive 1000');
  stop.abort();

  assert.deepEqual(byTable(dropped).drafts, [
    { table: 'drafts', op: 'truncate' },
  ]);
  assert.deepEqual(after, [
    {
      table: 'archive',
      op: 'insert',
      key: { id: 1000 },
      after: { id: 1000 },
    },
  ]);
});

test('a VACUUM that gives the rows of a table with no primary key new rowids gives an event for each rowid whose row changed', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE tags (tag TEXT);
     INSERT INTO tags VALUES ('a'), ('b'), ('c');
     DELETE FROM tags WHERE tag = 'a';`,
  );
  using feed = new Changefeed(path, join(dir.path, 'position.sqlite'));
  const stop = new AbortController();
  const batches = feed.watch({ interval: 5, signal: stop.signal });
  await nextBatch(batches, 'the reads of tags');

  owner.exec('VACUUM');
  const batch = await nextBatch(batches, 'the VACUUM changes');
  stop.abort();

  assert.deepEqual(batch, [
    { table: 'tags', op: 'insert', key: { rowid: 1 }, after: { tag: 'b' } },
    { table: 'tags', op: 'update', key: { rowid: 2 }, after: { tag: 'c' } },
    { table: 'tags', op: 'delete', key: { rowid: 3 } },
  ]);
});

test('a database not in WAL mode is a JournalModeError at open, and at the pass after the owner replaced the file with one', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const rollback = join(dir.path, 'rollback.sqlite');
  const journal = new DatabaseSync(rollback);
  journal.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)');
  journal.close();
  const path = join(dir.path, 'owner.sqlite');
  owned(path, 'CREATE TABLE notes (id INTEGER PRIMARY KEY)').close();
  using feed = new Changefeed(path);
  const batches = feed.watch({
    interval: 5,
    signal: new AbortController().signal,
  });
  const isJournalMode = (error: unknown) => {
    assert.ok(error instanceof JournalModeError);
    assert.equal(error.journalMode, 'delete');
    return true;
  };

  assert.throws(
    () => new Changefeed(rollback),
    (error: unknown) => {
      isJournalMode(error);
      assert.ok(error instanceof JournalModeError);
      assert.equal(error.path, rollback);
      return true;
    },
  );
  const next = batches.next();
  await setImmediate();
  renameSync(rollback, path);
  await assert.rejects(next, isJournalMode);
});

test('a missing database is the UnavailableError of @zukhruf/sqlite-reader', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const missing = join(dir.path, 'missing', 'owner.sqlite');

  assert.throws(
    () => new Changefeed(missing, join(dir.path, 'position.sqlite')),
    (error: unknown) => {
      assert.equal(UnavailableError, reader.UnavailableError);
      assert.ok(error instanceof reader.UnavailableError);
      assert.equal(error.path, missing);
      return true;
    },
  );
});

test('a pass that finds no change gives no batch, and the next batch holds only the change after it', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  const position = join(dir.path, 'position.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  using feed = new Changefeed(path, position);
  const stop = new AbortController();
  const batches = feed.watch({ interval: 5, signal: stop.signal });
  await nextBatch(batches, 'the read of note 1');
  using observer = new DatabaseSync(position, { readOnly: true });
  const positionVersion = () =>
    observer.prepare('PRAGMA data_version').get()?.data_version;

  // next() saves the read of note 1 before it returns.
  const next = batches.next();
  const nextSettled = settled(next);
  const saved = positionVersion();
  // A new table with no rows: a pass with no event that saves its key
  // columns. Its save is the sign that the pass ran.
  owner.exec('CREATE TABLE archive (id INTEGER PRIMARY KEY)');
  await until(
    () => nextSettled() || positionVersion() !== saved,
    'save of the pass with no event',
  );
  owner.exec("INSERT INTO notes VALUES (2, 'b')");
  const batch = await within(next, 'batch with the insert of note 2');
  stop.abort();

  assert.deepEqual(batch, {
    done: false,
    value: [
      {
        table: 'notes',
        op: 'insert',
        key: { id: 2 },
        after: { id: 2, title: 'b' },
      },
    ],
  });
});

test('an abort after a batch gives the batch again at the next run of a durable feed', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  const position = join(dir.path, 'position.sqlite');
  using _owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  const read = {
    table: 'notes',
    op: 'read',
    key: { id: 1 },
    after: { id: 1, title: 'a' },
  };
  {
    using feed = new Changefeed(path, position);
    const stop = new AbortController();
    const batches = feed.watch({ interval: 5, signal: stop.signal });
    assert.deepEqual(await nextBatch(batches, 'the read of note 1'), [read]);
    stop.abort(new Error('stopped'));
    await assert.rejects(batches.next(), /stopped/);
  }

  using feed = new Changefeed(path, position);
  const stop = new AbortController();
  const batch = await nextBatch(
    feed.watch({ interval: 5, signal: stop.signal }),
    'the read of note 1 again',
  );
  stop.abort();

  assert.deepEqual(batch, [read]);
});

test('a primary key that can hold NULL keys a row by rowid, and an integer primary key in lower case keys it by its column, but INTEGER PRIMARY KEY DESC, which is no alias of the rowid, keys it by rowid', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using _owner = owned(
    path,
    `CREATE TABLE entries (n INTEGER, t TEXT, PRIMARY KEY (n, t));
     INSERT INTO entries VALUES (1, NULL);
     CREATE TABLE items (id integer primary key, name TEXT);
     INSERT INTO items VALUES (5, 'x');
     CREATE TABLE ranks (id INTEGER PRIMARY KEY DESC, name TEXT);
     INSERT INTO ranks VALUES (NULL, 'a'), (NULL, 'b');`,
  );
  using feed = new Changefeed(path, join(dir.path, 'position.sqlite'));
  const stop = new AbortController();

  const batch = await nextBatch(
    feed.watch({ interval: 5, signal: stop.signal }),
    'the reads of entries, items and ranks',
  );
  stop.abort();

  assert.deepEqual(byTable(batch), {
    entries: [
      {
        table: 'entries',
        op: 'read',
        key: { rowid: 1 },
        after: { n: 1, t: null },
      },
    ],
    items: [
      {
        table: 'items',
        op: 'read',
        key: { id: 5 },
        after: { id: 5, name: 'x' },
      },
    ],
    ranks: [
      {
        table: 'ranks',
        op: 'read',
        key: { rowid: 1 },
        after: { id: null, name: 'a' },
      },
      {
        table: 'ranks',
        op: 'read',
        key: { rowid: 2 },
        after: { id: null, name: 'b' },
      },
    ],
  });
});

test('a BLOB key saved in the position comes back as the same bytes in the update and delete of a later run', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  const position = join(dir.path, 'position.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE files (hash BLOB PRIMARY KEY, body TEXT) WITHOUT ROWID;
     INSERT INTO files VALUES (x'00ff01', 'one'), (x'00ff02', 'two');`,
  );
  {
    using feed = new Changefeed(path, position);
    const stop = new AbortController();
    const batches = feed.watch({ interval: 5, signal: stop.signal });
    await nextBatch(batches, 'the reads of files');
    const next = batches.next();
    stop.abort(new Error('stopped'));
    await assert.rejects(next, /stopped/);
  }
  owner.exec(`UPDATE files SET body = 'ONE' WHERE hash = x'00ff01';
    DELETE FROM files WHERE hash = x'00ff02';`);

  using feed = new Changefeed(path, position);
  const stop = new AbortController();
  const batch = await nextBatch(
    feed.watch({ interval: 5, signal: stop.signal }),
    'the update and delete of files',
  );
  stop.abort();

  assert.deepEqual(batch, [
    {
      table: 'files',
      op: 'update',
      key: { hash: new Uint8Array([0, 255, 1]) },
      after: { hash: new Uint8Array([0, 255, 1]), body: 'ONE' },
    },
    {
      table: 'files',
      op: 'delete',
      key: { hash: new Uint8Array([0, 255, 2]) },
    },
  ]);
});
