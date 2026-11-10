import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

import { poll } from '@zukhruf/async';
import * as sqliteOpen from '@zukhruf/sqlite-open';
import { TemporaryFiles } from '@zukhruf/testing/fs';

import {
  Baseline,
  type Batch,
  type ChangeEvent,
  Changefeed,
  JournalModeError,
  PositionFile,
  PositionInMemory,
  ReadEveryRow,
  UnavailableError,
} from './index.ts';

// A feed that keeps its position in a file and reads each row at its first
// run.
function durable(path: string, position: string): Changefeed {
  return new Changefeed(path, {
    position: new PositionFile(position),
    start: new ReadEveryRow(),
  });
}

// A feed that keeps its position in memory and starts from a baseline.
function observing(path: string): Changefeed {
  return new Changefeed(path, {
    position: new PositionInMemory(),
    start: new Baseline(),
  });
}

// The owner's connection to a new WAL database at the path.
function owned(path: string, sql: string): DatabaseSync {
  const owner = sqliteOpen.open(path);
  owner.exec(sql);
  return owner;
}

// A watch that gives no batch fails here, naming the batch it waited for,
// and not at the timeout of the runner.
async function within<T>(promise: Promise<T>, expected: string): Promise<T> {
  const timeout = AbortSignal.timeout(10_000);
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
  batches: AsyncGenerator<Batch, void, undefined>,
  expected: string,
): Promise<ChangeEvent[]> {
  const next = await within(batches.next(), `batch with ${expected}`);
  assert.ok(!next.done, 'the watch ended');
  return [...next.value];
}

// A result of a watch's next(), with the events of its batch as an array.
function eventsOf(result: IteratorResult<Batch, void>) {
  return {
    done: result.done,
    value: result.done ? undefined : [...result.value],
  };
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
      signal: AbortSignal.timeout(10_000),
      clock: globalThis,
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
  using feed = durable(path, join(dir.path, 'position.sqlite'));
  const stop = new AbortController();

  const batch = await nextBatch(
    feed.watch({ clock: globalThis, interval: 5, signal: stop.signal }),
    'the reads of each table',
  );
  stop.abort();

  assert.deepEqual(byTable(batch), {
    codes: [
      {
        table: 'codes',
        op: 'read',
        key: { rowid: 1n },
        after: { code: null, label: 'a' },
      },
      {
        table: 'codes',
        op: 'read',
        key: { rowid: 2n },
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
        key: { id: 1n },
        after: { id: 1n, title: 'Plan' },
      },
    ],
    pairs: [
      {
        table: 'pairs',
        op: 'read',
        key: { b: 1n, a: 'x' },
        after: { a: 'x', b: 1n, n: 10n },
      },
    ],
    tags: [
      {
        table: 'tags',
        op: 'read',
        key: { rowid: 1n },
        after: { note_id: 1n, tag: 'q4' },
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
    using feed = durable(path, position);
    const stop = new AbortController();
    const batches = feed.watch({
      clock: globalThis,
      interval: 5,
      signal: stop.signal,
    });
    await nextBatch(batches, 'the reads of notes');
    const next = batches.next();
    stop.abort(new Error('stopped'));
    await assert.rejects(next, /stopped/);
  }
  owner.exec(`INSERT INTO notes VALUES (4, 'd');
    UPDATE notes SET title = 'B' WHERE id = 2;
    DELETE FROM notes WHERE id = 3;`);

  const resumed = await (async () => {
    using feed = durable(path, position);
    const stop = new AbortController();
    const batches = feed.watch({
      clock: globalThis,
      interval: 5,
      signal: stop.signal,
    });
    const batch = await nextBatch(batches, 'the changes while stopped');
    const next = batches.next();
    stop.abort(new Error('stopped'));
    await assert.rejects(next, /stopped/);
    return batch;
  })();
  owner.exec('DELETE FROM notes WHERE id = 4');
  using feed = durable(path, position);
  const stop = new AbortController();
  const last = await nextBatch(
    feed.watch({ clock: globalThis, interval: 5, signal: stop.signal }),
    'the delete of note 4',
  );
  stop.abort();

  assert.deepEqual(resumed, [
    {
      table: 'notes',
      op: 'update',
      key: { id: 2n },
      after: { id: 2n, title: 'B' },
      changed: ['title'],
    },
    {
      table: 'notes',
      op: 'insert',
      key: { id: 4n },
      after: { id: 4n, title: 'd' },
    },
    { table: 'notes', op: 'delete', key: { id: 3n } },
  ]);
  assert.deepEqual(last, [{ table: 'notes', op: 'delete', key: { id: 4n } }]);
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
    using feed = durable(path, position);
    const batches = feed.watch({
      clock: globalThis,
      interval: 5,
      signal: new AbortController().signal,
    });
    await nextBatch(batches, 'the read of note 1');
    owner.exec("INSERT INTO notes VALUES (2, 'b')");
    await nextBatch(batches, 'the insert of note 2');
    await batches.return();
  }

  using feed = durable(path, position);
  const stop = new AbortController();
  const batch = await nextBatch(
    feed.watch({ clock: globalThis, interval: 5, signal: stop.signal }),
    'the insert of note 2 again',
  );
  stop.abort();

  assert.deepEqual(batch, [
    {
      table: 'notes',
      op: 'insert',
      key: { id: 2n },
      after: { id: 2n, title: 'b' },
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
  using feed = observing(path);
  const stop = new AbortController();
  const batches = feed.watch({
    clock: globalThis,
    interval: 5,
    signal: stop.signal,
  });

  const first = batches.next();
  // The baseline pass runs in microtasks, with no I/O but node:sqlite's
  // synchronous calls, so it ends before an immediate runs.
  await setImmediate();
  owner.exec(
    "UPDATE notes SET title = 'A' WHERE id = 1; DELETE FROM notes WHERE id = 2",
  );
  const batch = await first;
  stop.abort();

  assert.deepEqual(eventsOf(batch), {
    done: false,
    value: [
      {
        table: 'notes',
        op: 'update',
        key: { id: 1n },
        after: { id: 1n, title: 'A' },
        changed: ['title'],
      },
      { table: 'notes', op: 'delete', key: { id: 2n } },
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
  using feed = durable(path, join(dir.path, 'position.sqlite'));
  const stop = new AbortController();
  const batches = feed.watch({
    clock: globalThis,
    interval: 5,
    signal: stop.signal,
  });
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
      { table: 'archive', op: 'insert', key: { id: 1n }, after: { id: 1n } },
    ],
    folders: [
      {
        table: 'folders',
        op: 'read',
        key: { id: 7n },
        after: { id: 7n, name: 'Work' },
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
    [{ table: 'archive', op: 'insert', key: { id: 2n }, after: { id: 2n } }],
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
  using feed = observing(path);
  const stop = new AbortController();
  const batches = feed.watch({
    clock: globalThis,
    interval: 5,
    signal: stop.signal,
  });
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
      key: { id: 1000n },
      after: { id: 1000n },
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
  using feed = durable(path, join(dir.path, 'position.sqlite'));
  const stop = new AbortController();
  const batches = feed.watch({
    clock: globalThis,
    interval: 5,
    signal: stop.signal,
  });
  await nextBatch(batches, 'the reads of tags');

  owner.exec('VACUUM');
  const batch = await nextBatch(batches, 'the VACUUM changes');
  stop.abort();

  assert.deepEqual(batch, [
    { table: 'tags', op: 'insert', key: { rowid: 1n }, after: { tag: 'b' } },
    {
      table: 'tags',
      op: 'update',
      key: { rowid: 2n },
      after: { tag: 'c' },
      changed: ['tag'],
    },
    { table: 'tags', op: 'delete', key: { rowid: 3n } },
  ]);
});

test('a database not in WAL mode is a JournalModeError at open, and at the pass after the owner replaced the file with one', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const rollback = join(dir.path, 'rollback.sqlite');
  const journal = sqliteOpen.open(rollback, {
    journal: new sqliteOpen.RollbackJournal(),
  });
  journal.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY)');
  journal.close();
  const path = join(dir.path, 'owner.sqlite');
  owned(path, 'CREATE TABLE notes (id INTEGER PRIMARY KEY)').close();
  using feed = observing(path);
  const batches = feed.watch({
    clock: globalThis,
    interval: 5,
    signal: new AbortController().signal,
  });
  const isJournalMode = (error: unknown) => {
    assert.ok(error instanceof JournalModeError);
    assert.equal(error.journalMode, 'delete');
    return true;
  };

  assert.throws(
    () => observing(rollback),
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

test('a missing database is the UnavailableError of @zukhruf/sqlite-open', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const missing = join(dir.path, 'missing', 'owner.sqlite');

  assert.throws(
    () => durable(missing, join(dir.path, 'position.sqlite')),
    (error: unknown) => {
      assert.equal(UnavailableError, sqliteOpen.UnavailableError);
      assert.ok(error instanceof sqliteOpen.UnavailableError);
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
  using feed = durable(path, position);
  const stop = new AbortController();
  const batches = feed.watch({
    clock: globalThis,
    interval: 5,
    signal: stop.signal,
  });
  await nextBatch(batches, 'the read of note 1');
  using observer = sqliteOpen.open(position, { readOnly: true });
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

  assert.deepEqual(eventsOf(batch), {
    done: false,
    value: [
      {
        table: 'notes',
        op: 'insert',
        key: { id: 2n },
        after: { id: 2n, title: 'b' },
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
    key: { id: 1n },
    after: { id: 1n, title: 'a' },
  };
  {
    using feed = durable(path, position);
    const stop = new AbortController();
    const batches = feed.watch({
      clock: globalThis,
      interval: 5,
      signal: stop.signal,
    });
    assert.deepEqual(await nextBatch(batches, 'the read of note 1'), [read]);
    stop.abort(new Error('stopped'));
    await assert.rejects(batches.next(), /stopped/);
  }

  using feed = durable(path, position);
  const stop = new AbortController();
  const batch = await nextBatch(
    feed.watch({ clock: globalThis, interval: 5, signal: stop.signal }),
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
  using feed = durable(path, join(dir.path, 'position.sqlite'));
  const stop = new AbortController();

  const batch = await nextBatch(
    feed.watch({ clock: globalThis, interval: 5, signal: stop.signal }),
    'the reads of entries, items and ranks',
  );
  stop.abort();

  assert.deepEqual(byTable(batch), {
    entries: [
      {
        table: 'entries',
        op: 'read',
        key: { rowid: 1n },
        after: { n: 1n, t: null },
      },
    ],
    items: [
      {
        table: 'items',
        op: 'read',
        key: { id: 5n },
        after: { id: 5n, name: 'x' },
      },
    ],
    ranks: [
      {
        table: 'ranks',
        op: 'read',
        key: { rowid: 1n },
        after: { id: null, name: 'a' },
      },
      {
        table: 'ranks',
        op: 'read',
        key: { rowid: 2n },
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
    using feed = durable(path, position);
    const stop = new AbortController();
    const batches = feed.watch({
      clock: globalThis,
      interval: 5,
      signal: stop.signal,
    });
    await nextBatch(batches, 'the reads of files');
    const next = batches.next();
    stop.abort(new Error('stopped'));
    await assert.rejects(next, /stopped/);
  }
  owner.exec(`UPDATE files SET body = 'ONE' WHERE hash = x'00ff01';
    DELETE FROM files WHERE hash = x'00ff02';`);

  using feed = durable(path, position);
  const stop = new AbortController();
  const batch = await nextBatch(
    feed.watch({ clock: globalThis, interval: 5, signal: stop.signal }),
    'the update and delete of files',
  );
  stop.abort();

  assert.deepEqual(batch, [
    {
      table: 'files',
      op: 'update',
      key: { hash: new Uint8Array([0, 255, 1]) },
      after: { hash: new Uint8Array([0, 255, 1]), body: 'ONE' },
      changed: ['body'],
    },
    {
      table: 'files',
      op: 'delete',
      key: { hash: new Uint8Array([0, 255, 2]) },
    },
  ]);
});

test('a feed that is disposed during its watch ends the watch with the error of its data version, and does not poll a closed database', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using _owner = owned(
    path,
    'CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);',
  );
  // An observing feed keeps its position in memory, so after the dispose
  // only the read of the data version can fail.
  const feed = observing(path);
  const stop = new AbortController();
  try {
    const next = feed
      .watch({ clock: globalThis, interval: 5, signal: stop.signal })
      .next();
    // The baseline pass ends before an immediate runs; the watch then waits
    // for its next check.
    await setImmediate();

    feed[Symbol.dispose]();

    await assert.rejects(
      within(next, 'end of the watch'),
      /statement has been finalized/,
    );
  } finally {
    stop.abort();
  }
});

test('a durable feed that starts from a baseline gives no reads at its first run, and a new run gives only what the owner changed while it was stopped', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  const position = join(dir.path, 'position.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a'), (2, 'b');`,
  );
  const feed = () =>
    new Changefeed(path, {
      position: new PositionFile(position),
      start: new Baseline(),
    });
  {
    using first = feed();
    const stop = new AbortController();
    const next = first
      .watch({ clock: globalThis, interval: 5, signal: stop.signal })
      .next();
    // The baseline pass ends before an immediate runs, and saves at once.
    await setImmediate();
    owner.exec("INSERT INTO notes VALUES (3, 'c')");
    assert.deepEqual(
      eventsOf(await within(next, 'batch with the insert of note 3')),
      {
        done: false,
        value: [
          {
            table: 'notes',
            op: 'insert',
            key: { id: 3n },
            after: { id: 3n, title: 'c' },
          },
        ],
      },
    );
    stop.abort();
  }
  owner.exec("UPDATE notes SET title = 'A' WHERE id = 1");

  using second = feed();
  const stop = new AbortController();
  const batch = await nextBatch(
    second.watch({ clock: globalThis, interval: 5, signal: stop.signal }),
    'the insert of note 3 again and the update of note 1',
  );
  stop.abort();

  assert.deepEqual(batch, [
    {
      table: 'notes',
      op: 'update',
      key: { id: 1n },
      after: { id: 1n, title: 'A' },
      changed: ['title'],
    },
    {
      table: 'notes',
      op: 'insert',
      key: { id: 3n },
      after: { id: 3n, title: 'c' },
    },
  ]);
});

test('a baseline of a database with no tables still starts the position: a table that the owner creates later gives reads, also in a new run', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  const position = join(dir.path, 'position.sqlite');
  using owner = owned(path, 'PRAGMA user_version = 1');
  {
    using first = new Changefeed(path, {
      position: new PositionFile(position),
      start: new Baseline(),
    });
    const stop = new AbortController();
    const next = first
      .watch({ clock: globalThis, interval: 5, signal: stop.signal })
      .next();
    await setImmediate();
    stop.abort(new Error('stopped'));
    await assert.rejects(next, /stopped/);
  }
  owner.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
    INSERT INTO notes VALUES (1, 'a');`);

  using second = new Changefeed(path, {
    position: new PositionFile(position),
    start: new Baseline(),
  });
  const stop = new AbortController();
  const batch = await nextBatch(
    second.watch({ clock: globalThis, interval: 5, signal: stop.signal }),
    'the read of note 1',
  );
  stop.abort();

  assert.deepEqual(batch, [
    {
      table: 'notes',
      op: 'read',
      key: { id: 1n },
      after: { id: 1n, title: 'a' },
    },
  ]);
});

test('a feed that keeps its position in memory and reads each row gives every row as a read at each new run', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using _owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  const read = async () => {
    using feed = new Changefeed(path, {
      position: new PositionInMemory(),
      start: new ReadEveryRow(),
    });
    const stop = new AbortController();
    const batch = await nextBatch(
      feed.watch({ clock: globalThis, interval: 5, signal: stop.signal }),
      'the read of note 1',
    );
    stop.abort();
    return batch;
  };

  const runs = [await read(), await read()];

  const note = {
    table: 'notes',
    op: 'read',
    key: { id: 1n },
    after: { id: 1n, title: 'a' },
  };
  assert.deepEqual(runs, [[note], [note]]);
});

test('an integer beyond 2^53 reads exactly in a row and in a key, and the saved position gives the key back in the delete of a later run', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  const position = join(dir.path, 'position.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE visits (id INTEGER PRIMARY KEY, task INTEGER);
     INSERT INTO visits VALUES (9223372036854775807, 13399287446400972);`,
  );
  const first = await (async () => {
    using feed = durable(path, position);
    const stop = new AbortController();
    const batches = feed.watch({
      clock: globalThis,
      interval: 5,
      signal: stop.signal,
    });
    const batch = await nextBatch(batches, 'the read of the visit');
    const next = batches.next();
    stop.abort(new Error('stopped'));
    await assert.rejects(next, /stopped/);
    return batch;
  })();
  owner.exec('DELETE FROM visits');

  using feed = durable(path, position);
  const stop = new AbortController();
  const later = await nextBatch(
    feed.watch({ clock: globalThis, interval: 5, signal: stop.signal }),
    'the delete of the visit',
  );
  stop.abort();

  assert.deepEqual(first, [
    {
      table: 'visits',
      op: 'read',
      key: { id: 9223372036854775807n },
      after: { id: 9223372036854775807n, task: 13399287446400972n },
    },
  ]);
  assert.deepEqual(later, [
    { table: 'visits', op: 'delete', key: { id: 9223372036854775807n } },
  ]);
});

test('the first run of a table with more rows than a call takes arguments gives a read for each row', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  // 150,000 rows: a spread of that many events into one call overflows the
  // stack of V8 (about 125,000 arguments on Node.js 26 on macOS arm64).
  using _owner = owned(
    path,
    `CREATE TABLE events (id INTEGER PRIMARY KEY);
     WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 150000)
     INSERT INTO events SELECT i FROM n;`,
  );
  using feed = durable(path, join(dir.path, 'position.sqlite'));
  const stop = new AbortController();
  const batches = feed.watch({
    clock: globalThis,
    interval: 5,
    signal: stop.signal,
  });

  const next = await Promise.race([
    batches.next(),
    new Promise<never>((_, reject) =>
      AbortSignal.timeout(60_000).addEventListener('abort', () =>
        reject(new Error('no batch with 150,000 reads within 60 s')),
      ),
    ),
  ]);
  stop.abort();

  assert.ok(!next.done, 'the watch ended');
  assert.equal(next.value.events.length, 150_000);
  assert.ok(next.value.events.every((event) => event.op === 'read'));
});

test('a durable feed numbers each batch by the saves of its position, and a batch given again after a stop keeps its number', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  const position = join(dir.path, 'position.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  const feed = () =>
    new Changefeed(path, {
      position: new PositionFile(position),
      start: new ReadEveryRow(),
    });
  const numbers = await (async () => {
    using first = feed();
    const stop = new AbortController();
    const batches = first.watch({
      clock: globalThis,
      interval: 5,
      signal: stop.signal,
    });
    const read = await within(batches.next(), 'the read of note 1');
    owner.exec("INSERT INTO notes VALUES (2, 'b')");
    const inserted = await within(batches.next(), 'the insert of note 2');
    // The stop comes before the loop asks for the next batch, so the insert
    // is not saved.
    stop.abort(new Error('stopped'));
    await assert.rejects(batches.next(), /stopped/);
    assert.ok(!read.done && !inserted.done);
    return [read.value.sequence, inserted.value.sequence];
  })();

  using second = feed();
  const stop = new AbortController();
  const again = await within(
    second
      .watch({ clock: globalThis, interval: 5, signal: stop.signal })
      .next(),
    'the insert of note 2 again',
  );
  stop.abort();

  assert.deepEqual(numbers, [1, 2]);
  assert.ok(!again.done);
  assert.equal(again.value.sequence, 2);
  assert.deepEqual(
    [...again.value],
    [
      {
        table: 'notes',
        op: 'insert',
        key: { id: 2n },
        after: { id: 2n, title: 'b' },
      },
    ],
  );
});

test('a feed whose position is in memory gives batches with no sequence, so a host cannot keep one across runs', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using _owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY);
     INSERT INTO notes VALUES (1);`,
  );
  using feed = new Changefeed(path, {
    position: new PositionInMemory(),
    start: new ReadEveryRow(),
  });
  const stop = new AbortController();

  const next = await within(
    feed.watch({ clock: globalThis, interval: 5, signal: stop.signal }).next(),
    'the read of row 1',
  );
  stop.abort();

  assert.ok(!next.done);
  // @ts-expect-error A batch of a position in memory has no sequence.
  assert.equal(next.value.sequence, undefined);
  assert.deepEqual([...next.value].length, 1);
});

test('an update names the columns whose values changed, also after a stop, and a new or a dropped column is the change of each row', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  const position = join(dir.path, 'position.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT, is_read INTEGER, date_read INTEGER);
     INSERT INTO messages VALUES (1, 'Pay JOD 6.820', 0, NULL), (2, 'Lunch?', 0, NULL);`,
  );
  const changes = async (change: string) => {
    owner.exec(change);
    using feed = new Changefeed(path, {
      position: new PositionFile(position),
      start: new Baseline(),
    });
    const stop = new AbortController();
    const batches = feed.watch({
      clock: globalThis,
      interval: 5,
      signal: stop.signal,
    });
    const batch = await nextBatch(batches, change);
    // The loop asks for the next batch before the stop, so this one is saved.
    const next = batches.next();
    stop.abort(new Error('stopped'));
    await assert.rejects(next, /stopped/);
    return batch.map((event) =>
      event.op === 'update'
        ? `${String(event.key.id)} ${event.changed.join(',')}`
        : event.op,
    );
  };
  {
    using baseline = new Changefeed(path, {
      position: new PositionFile(position),
      start: new Baseline(),
    });
    const stop = new AbortController();
    const next = baseline
      .watch({ clock: globalThis, interval: 5, signal: stop.signal })
      .next();
    await setImmediate();
    stop.abort(new Error('stopped'));
    await assert.rejects(next, /stopped/);
  }

  const read = await changes(
    'UPDATE messages SET is_read = 1, date_read = 800 WHERE id = 1',
  );
  const edited = await changes(
    "UPDATE messages SET body = 'Lunch at 1?' WHERE id = 2",
  );
  const added = await changes('ALTER TABLE messages ADD COLUMN service TEXT');
  const dropped = await changes('ALTER TABLE messages DROP COLUMN date_read');

  assert.deepEqual(read, ['1 is_read,date_read']);
  assert.deepEqual(edited, ['2 body']);
  assert.deepEqual(added, ['1 service', '2 service']);
  assert.deepEqual(dropped, ['1 date_read', '2 date_read']);
});

// A durable feed of the owner's database that reads each row at its first
// run, with the batches of one watch.
function followed(path: string, position: string) {
  const feed = durable(path, position);
  const stop = new AbortController();
  const batches = feed.watch({
    clock: globalThis,
    interval: 5,
    signal: stop.signal,
  });
  return {
    batches,
    async [Symbol.asyncDispose]() {
      const next = batches.next();
      stop.abort(new Error('stopped'));
      await assert.rejects(next, /stopped/);
      feed[Symbol.dispose]();
    },
  };
}

test('while the owner keeps its WAL, each pass gives the changes of each table that its frames touched, a new table, and a dropped one', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `PRAGMA wal_autocheckpoint = 0;
     CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);
     CREATE TABLE b (id INTEGER PRIMARY KEY, v TEXT);
     INSERT INTO a VALUES (1, 'x');
     INSERT INTO b VALUES (1, 'y');`,
  );
  await using feed = followed(path, join(dir.path, 'position.sqlite'));
  const ops = async (sql: string) => {
    owner.exec(sql);
    return (await nextBatch(feed.batches, sql)).map((event) =>
      event.op === 'truncate'
        ? `${event.table} truncate`
        : `${event.table} ${event.op} ${String(Object.values(event.key)[0])}`,
    );
  };
  await nextBatch(feed.batches, 'the first reads');

  const updated = await ops("UPDATE a SET v = 'x2' WHERE id = 1");
  const inserted = await ops("INSERT INTO b VALUES (2, 'z')");
  const created = await ops(
    'CREATE TABLE c (id INTEGER PRIMARY KEY); INSERT INTO c VALUES (1)',
  );
  const dropped = await ops('DROP TABLE a');

  assert.deepEqual(updated, ['a update 1']);
  assert.deepEqual(inserted, ['b insert 2']);
  assert.deepEqual(created, ['c read 1']);
  assert.deepEqual(dropped, ['a truncate']);
});

test('changes that a WAL reset removed while the feed was stopped come at the next run, with the changes after the reset', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  const position = join(dir.path, 'position.sqlite');
  using owner = owned(
    path,
    `PRAGMA wal_autocheckpoint = 0;
     CREATE TABLE a (id INTEGER PRIMARY KEY, v TEXT);
     CREATE TABLE b (id INTEGER PRIMARY KEY, v TEXT);
     INSERT INTO a VALUES (1, 'x');
     INSERT INTO b VALUES (1, 'y');`,
  );
  {
    await using feed = followed(path, position);
    await nextBatch(feed.batches, 'the first reads');
  }
  owner.exec(`UPDATE a SET v = 'x2' WHERE id = 1;
    PRAGMA wal_checkpoint(TRUNCATE);`);
  // One commit for each row: the new WAL has more frames than the old one,
  // so only its salt tells that it is a new WAL.
  const insert = owner.prepare('INSERT INTO b VALUES (?, ?)');
  for (let id = 2; id <= 41; id++) insert.run(id, 'z');

  await using feed = followed(path, position);
  const batch = await nextBatch(feed.batches, 'the changes around the reset');

  const tables = byTable(batch);
  assert.deepEqual(tables.a, [
    {
      table: 'a',
      op: 'update',
      key: { id: 1n },
      after: { id: 1n, v: 'x2' },
      changed: ['v'],
    },
  ]);
  assert.equal(tables.b?.length, 40);
});

test('an update of a row whose text spills onto overflow pages comes from the frames of its leaf page', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  const large = (letter: string) => letter.repeat(20_000);
  using owner = owned(
    path,
    `PRAGMA wal_autocheckpoint = 0;
     CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT);
     CREATE TABLE other (id INTEGER PRIMARY KEY);
     INSERT INTO notes VALUES (1, '${large('a')}');`,
  );
  await using feed = followed(path, join(dir.path, 'position.sqlite'));
  await nextBatch(feed.batches, 'the first reads');

  owner.exec(`UPDATE notes SET body = '${large('b')}' WHERE id = 1`);
  const batch = await nextBatch(feed.batches, 'the update of the large note');

  assert.deepEqual(
    batch.map((event) => (event.op === 'update' ? event.changed : event.op)),
    [['body']],
  );
});
