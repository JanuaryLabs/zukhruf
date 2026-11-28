import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';

import { untilAborted } from '@zukhruf/async';
import {
  CheckpointFencedError,
  type CheckpointStore,
  ConsumerGroup,
  type Format,
  IncompatibleCheckpointError,
  type Json,
  MemoryCheckpointStore,
  type StateChanges,
} from '@zukhruf/checkpoint';
import {
  SqliteCheckpointStore,
  type SqliteWrite,
} from '@zukhruf/checkpoint/sqlite';
import { TemporaryFiles } from '@zukhruf/fs';
import { test } from '@zukhruf/parameterized-test';
import * as sqliteOpen from '@zukhruf/sqlite-open';

import {
  Baseline,
  type ChangeEvent,
  Changefeed,
  JournalModeError,
  ReadEveryRow,
  UnavailableError,
} from './index.ts';

type Batches = AsyncGenerator<readonly ChangeEvent[], void, undefined>;

// The stream of the owner's database in the host's consumer group.
const stream = 'owner';

// The host's own SQLite database, which keeps the feed's checkpoint.
function hostOf(dir: string): DatabaseSync {
  return sqliteOpen.open(join(dir, 'host.sqlite'));
}

// A feed whose checkpoint is in the host's database, and that reads each row
// at its first run.
function durable(path: string, host: DatabaseSync): Changefeed<SqliteWrite> {
  return new Changefeed(path, {
    checkpoints: new ConsumerGroup(
      'host',
      new SqliteCheckpointStore({ database: host }),
    ),
    stream,
    start: new ReadEveryRow(),
  });
}

// A durable feed that starts from a baseline.
function durableBaseline(
  path: string,
  host: DatabaseSync,
): Changefeed<SqliteWrite> {
  return new Changefeed(path, {
    checkpoints: new ConsumerGroup(
      'host',
      new SqliteCheckpointStore({ database: host }),
    ),
    stream,
    start: new Baseline(),
  });
}

// A feed whose checkpoint is in memory, and that starts from a baseline.
function observing(path: string): Changefeed<never> {
  return new Changefeed(path, {
    checkpoints: new ConsumerGroup('host', new MemoryCheckpointStore()),
    stream,
    start: new Baseline(),
  });
}

// The owner's connection to a new WAL database at the path.
function owned(path: string, sql: string): DatabaseSync {
  const owner = sqliteOpen.open(path);
  owner.exec(sql);
  return owner;
}

// A watch that gives no batch fails when the test ends, naming the batch it
// waited for.
async function within<T>(
  promise: Promise<T>,
  expected: string,
  signal: AbortSignal,
): Promise<T> {
  try {
    return await untilAborted(promise, signal);
  } catch (error) {
    if (error === signal.reason) {
      throw new Error(`no ${expected}`, { cause: error });
    }
    throw error;
  }
}

// The next batch of a watch.
async function nextBatch(
  batches: Batches,
  expected: string,
  signal: AbortSignal,
): Promise<ChangeEvent[]> {
  const next = await within(batches.next(), `batch with ${expected}`, signal);
  assert.ok(!next.done, 'the watch ended');
  return [...next.value];
}

// A result of a watch's next(), with the events of its batch as an array.
function eventsOf(result: IteratorResult<readonly ChangeEvent[], void>) {
  return {
    done: result.done,
    value: result.done ? undefined : [...result.value],
  };
}

// Stops a watch while it waits for its next pass.
async function stopped(batches: Batches, stop: AbortController) {
  const next = batches.next();
  stop.abort(new Error('stopped'));
  await assert.rejects(next, /stopped/);
}

// The events of a batch by table. The feed gives no order across tables.
function byTable(batch: ChangeEvent[]) {
  return { ...Object.groupBy(batch, (event) => event.table) };
}

// One watch of a feed: its first batch, and a stop that ends it.
async function watched<W>(
  feed: Changefeed<W>,
  expected: string,
  signal: AbortSignal,
) {
  const stop = new AbortController();
  const batches = feed.watch({
    clock: globalThis,
    interval: 5,
    signal: stop.signal,
  });
  const first = await nextBatch(batches, expected, signal);
  return {
    batches,
    first,
    async [Symbol.asyncDispose]() {
      await stopped(batches, stop);
    },
  };
}

// The stream and checkpoint id of each checkpoint of a consumer group.
async function checkpointsOf<W>(group: ConsumerGroup<W>): Promise<string[]> {
  return (await Array.fromAsync(group.list())).map(
    (checkpoint) => `${checkpoint.stream} ${checkpoint.checkpointId}`,
  );
}

test('the first run of a durable feed reads each row of each table, keyed by the identity SQLite enforces, and skips views, virtual, shadow and internal tables', async (t) => {
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
  using host = hostOf(dir.path);
  using feed = durable(path, host);
  const stop = new AbortController();

  const batch = await nextBatch(
    feed.watch({ clock: globalThis, interval: 5, signal: stop.signal }),
    'the reads of each table',
    t.signal,
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

test('a durable feed goes on from its commit: a new run gives only what the owner changed while it was stopped', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a'), (2, 'b'), (3, 'c');`,
  );
  using host = hostOf(dir.path);
  {
    using feed = durable(path, host);
    await using _run = await watched(feed, 'the reads of notes', t.signal);
    await feed.commit();
  }
  owner.exec(`INSERT INTO notes VALUES (4, 'd');
    UPDATE notes SET title = 'B' WHERE id = 2;
    DELETE FROM notes WHERE id = 3;`);

  const resumed = await (async () => {
    using feed = durable(path, host);
    await using run = await watched(
      feed,
      'the changes while stopped',
      t.signal,
    );
    await feed.commit();
    return run.first;
  })();
  owner.exec('DELETE FROM notes WHERE id = 4');
  using feed = durable(path, host);
  await using last = await watched(feed, 'the delete of note 4', t.signal);

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
  assert.deepEqual(last.first, [
    { table: 'notes', op: 'delete', key: { id: 4n } },
  ]);
});

test('a batch that the loop leaves with break, and does not commit, is given again at the next run', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  using host = hostOf(dir.path);
  {
    using feed = durable(path, host);
    const batches = feed.watch({
      clock: globalThis,
      interval: 5,
      signal: new AbortController().signal,
    });
    await nextBatch(batches, 'the read of note 1', t.signal);
    await feed.commit();
    owner.exec("INSERT INTO notes VALUES (2, 'b')");
    await nextBatch(batches, 'the insert of note 2', t.signal);
    await batches.return();
  }

  using feed = durable(path, host);
  await using again = await watched(
    feed,
    'the insert of note 2 again',
    t.signal,
  );

  assert.deepEqual(again.first, [
    {
      table: 'notes',
      op: 'insert',
      key: { id: 2n },
      after: { id: 2n, title: 'b' },
    },
  ]);
});

test('an observing feed gives an empty baseline batch, then only the changes after it started', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a'), (2, 'b');`,
  );
  using feed = observing(path);
  await using run = await watched(feed, 'the baseline', t.signal);

  owner.exec(
    "UPDATE notes SET title = 'A' WHERE id = 1; DELETE FROM notes WHERE id = 2",
  );
  const batch = await within(run.batches.next(), 'batch of changes', t.signal);

  assert.deepEqual(run.first, []);
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

test('a new table gives reads, an empty table it saw gives inserts, a dropped table a truncate, and a table with other key columns a truncate and then reads', async (t) => {
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
  using host = hostOf(dir.path);
  using feed = durable(path, host);
  await using run = await watched(feed, 'the first reads', t.signal);
  await feed.commit();

  owner.exec(`DROP TABLE drafts;
    CREATE TABLE folders (id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO folders VALUES (7, 'Work');
    ALTER TABLE labels RENAME TO old_labels;
    CREATE TABLE labels (name TEXT PRIMARY KEY NOT NULL, color TEXT);
    INSERT INTO labels SELECT * FROM old_labels;
    DROP TABLE old_labels;
    INSERT INTO archive VALUES (1);`);
  const batch = await nextBatch(run.batches, 'the schema changes', t.signal);
  await feed.commit();
  owner.exec('INSERT INTO archive VALUES (2)');
  const after = await nextBatch(
    run.batches,
    'the insert of archive 2',
    t.signal,
  );

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
    'a dropped table leaves the checkpoint',
  );
});

test('an observing feed gives the truncate of a dropped table once', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE drafts (id INTEGER PRIMARY KEY, body TEXT);
     INSERT INTO drafts VALUES (1, 'draft');
     CREATE TABLE archive (id INTEGER PRIMARY KEY);`,
  );
  using feed = observing(path);
  await using run = await watched(feed, 'the baseline', t.signal);

  owner.exec('DROP TABLE drafts');
  const dropped = await nextBatch(
    run.batches,
    'the truncate of drafts',
    t.signal,
  );
  owner.exec('INSERT INTO archive VALUES (1000)');
  const after = await nextBatch(
    run.batches,
    'the insert of archive 1000',
    t.signal,
  );

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

test('a VACUUM that gives the rows of a table with no primary key new rowids gives an event for each rowid whose row changed', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE tags (tag TEXT);
     INSERT INTO tags VALUES ('a'), ('b'), ('c');
     DELETE FROM tags WHERE tag = 'a';`,
  );
  using host = hostOf(dir.path);
  using feed = durable(path, host);
  await using run = await watched(feed, 'the reads of tags', t.signal);
  await feed.commit();

  owner.exec('VACUUM');
  const batch = await nextBatch(run.batches, 'the VACUUM changes', t.signal);

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

test('a database not in WAL mode is a JournalModeError at open, and at the pass after the owner replaced the file with one', async (t) => {
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
  await nextBatch(batches, 'the baseline', t.signal);
  const next = batches.next();
  await setImmediate();
  renameSync(rollback, path);
  await assert.rejects(next, isJournalMode);
});

test('a missing database is the UnavailableError of @zukhruf/sqlite-open', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const missing = join(dir.path, 'missing', 'owner.sqlite');
  using host = hostOf(dir.path);

  assert.throws(
    () => durable(missing, host),
    (error: unknown) => {
      assert.equal(UnavailableError, sqliteOpen.UnavailableError);
      assert.ok(error instanceof sqliteOpen.UnavailableError);
      assert.equal(error.path, missing);
      return true;
    },
  );
});

test('a pass that finds no change gives an empty batch, and the next batch holds only the change after it', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  using host = hostOf(dir.path);
  using feed = durable(path, host);
  await using run = await watched(feed, 'the read of note 1', t.signal);
  await feed.commit();

  // A new table with no rows: a pass with no event.
  owner.exec('CREATE TABLE archive (id INTEGER PRIMARY KEY)');
  const empty = await nextBatch(run.batches, 'no event', t.signal);
  await feed.commit();
  owner.exec("INSERT INTO notes VALUES (2, 'b')");
  const batch = await within(
    run.batches.next(),
    'batch with the insert of note 2',
    t.signal,
  );

  assert.deepEqual(empty, []);
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

test('an abort after a batch that the host did not commit gives the batch again at the next run of a durable feed', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using _owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  using host = hostOf(dir.path);
  const read = {
    table: 'notes',
    op: 'read',
    key: { id: 1n },
    after: { id: 1n, title: 'a' },
  };
  const first = await (async () => {
    using feed = durable(path, host);
    await using run = await watched(feed, 'the read of note 1', t.signal);
    return run.first;
  })();

  using feed = durable(path, host);
  await using again = await watched(feed, 'the read of note 1 again', t.signal);

  assert.deepEqual(first, [read]);
  assert.deepEqual(again.first, [read]);
});

test('a primary key that can hold NULL keys a row by rowid, and an integer primary key in lower case keys it by its column, but INTEGER PRIMARY KEY DESC, which is no alias of the rowid, keys it by rowid', async (t) => {
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
  using host = hostOf(dir.path);
  using feed = durable(path, host);
  await using run = await watched(
    feed,
    'the reads of entries, items and ranks',
    t.signal,
  );

  assert.deepEqual(byTable(run.first), {
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

test('a BLOB key in the checkpoint comes back as the same bytes in the update and delete of a later run', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE files (hash BLOB PRIMARY KEY, body TEXT) WITHOUT ROWID;
     INSERT INTO files VALUES (x'00ff01', 'one'), (x'00ff02', 'two');`,
  );
  using host = hostOf(dir.path);
  {
    using feed = durable(path, host);
    await using _run = await watched(feed, 'the reads of files', t.signal);
    await feed.commit();
  }
  owner.exec(`UPDATE files SET body = 'ONE' WHERE hash = x'00ff01';
    DELETE FROM files WHERE hash = x'00ff02';`);

  using feed = durable(path, host);
  await using run = await watched(
    feed,
    'the update and delete of files',
    t.signal,
  );

  assert.deepEqual(run.first, [
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

test('a feed that is disposed during its watch ends the watch with the error of its data version, and does not poll a closed database', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using _owner = owned(
    path,
    'CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);',
  );
  // An observing feed keeps its checkpoint in memory, so after the dispose
  // only the read of the data version can fail.
  const feed = observing(path);
  const stop = new AbortController();
  try {
    const batches = feed.watch({
      clock: globalThis,
      interval: 5,
      signal: stop.signal,
    });
    await nextBatch(batches, 'the baseline', t.signal);
    // The watch then waits for its next check.
    const next = batches.next();
    await setImmediate();

    feed[Symbol.dispose]();

    await assert.rejects(
      within(next, 'end of the watch', t.signal),
      /statement has been finalized/,
    );
  } finally {
    stop.abort();
  }
});

test('a durable feed that starts from a baseline gives an empty batch at its first run, and once that is committed a new run gives only what the owner changed after it', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a'), (2, 'b');`,
  );
  using host = hostOf(dir.path);
  {
    using first = durableBaseline(path, host);
    await using run = await watched(first, 'the baseline', t.signal);
    assert.deepEqual(run.first, []);
    await first.commit();
    owner.exec("INSERT INTO notes VALUES (3, 'c')");
    assert.deepEqual(
      eventsOf(
        await within(
          run.batches.next(),
          'batch with the insert of note 3',
          t.signal,
        ),
      ),
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
  }
  owner.exec("UPDATE notes SET title = 'A' WHERE id = 1");

  using second = durableBaseline(path, host);
  await using run = await watched(
    second,
    'the insert of note 3 again and the update of note 1',
    t.signal,
  );

  assert.deepEqual(run.first, [
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

test('a committed baseline of a database with no tables starts the checkpoint: a table that the owner creates later gives reads, also in a new run', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(path, 'PRAGMA user_version = 1');
  using host = hostOf(dir.path);
  {
    using first = durableBaseline(path, host);
    await using _run = await watched(first, 'the baseline', t.signal);
    await first.commit();
  }
  owner.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
    INSERT INTO notes VALUES (1, 'a');`);

  using second = durableBaseline(path, host);
  await using run = await watched(second, 'the read of note 1', t.signal);

  assert.deepEqual(run.first, [
    {
      table: 'notes',
      op: 'read',
      key: { id: 1n },
      after: { id: 1n, title: 'a' },
    },
  ]);
});

test('a feed that keeps its checkpoint in memory and reads each row gives every row as a read at each new run', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using _owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  const read = async () => {
    using feed = new Changefeed(path, {
      checkpoints: new ConsumerGroup('host', new MemoryCheckpointStore()),
      stream,
      start: new ReadEveryRow(),
    });
    await using run = await watched(feed, 'the read of note 1', t.signal);
    await feed.commit();
    return run.first;
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

test('an integer beyond 2^53 reads exactly in a row and in a key, and the checkpoint gives the key back in the delete of a later run', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE visits (id INTEGER PRIMARY KEY, task INTEGER);
     INSERT INTO visits VALUES (9223372036854775807, 13399287446400972);`,
  );
  using host = hostOf(dir.path);
  const first = await (async () => {
    using feed = durable(path, host);
    await using run = await watched(feed, 'the read of the visit', t.signal);
    await feed.commit();
    return run.first;
  })();
  owner.exec('DELETE FROM visits');

  using feed = durable(path, host);
  await using later = await watched(feed, 'the delete of the visit', t.signal);

  assert.deepEqual(first, [
    {
      table: 'visits',
      op: 'read',
      key: { id: 9223372036854775807n },
      after: { id: 9223372036854775807n, task: 13399287446400972n },
    },
  ]);
  assert.deepEqual(later.first, [
    { table: 'visits', op: 'delete', key: { id: 9223372036854775807n } },
  ]);
});

test('the first run of a table with more rows than a call takes arguments gives a read for each row', async (t) => {
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
  using host = hostOf(dir.path);
  using feed = durable(path, host);
  const stop = new AbortController();
  const batches = feed.watch({
    clock: globalThis,
    interval: 5,
    signal: stop.signal,
  });

  const next = await within(
    batches.next(),
    'batch with 150,000 reads',
    t.signal,
  );
  stop.abort();

  assert.ok(!next.done, 'the watch ended');
  assert.equal(next.value.length, 150_000);
  assert.ok(next.value.every((event) => event.op === 'read'));
});

test('an update names the columns whose values changed, also after a stop, and a new or a dropped column is the change of each row', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT, is_read INTEGER, date_read INTEGER);
     INSERT INTO messages VALUES (1, 'Pay JOD 6.820', 0, NULL), (2, 'Lunch?', 0, NULL);`,
  );
  using host = hostOf(dir.path);
  const changes = async (change: string) => {
    owner.exec(change);
    using feed = durableBaseline(path, host);
    await using run = await watched(feed, change, t.signal);
    await feed.commit();
    return run.first.map((event) =>
      event.op === 'update'
        ? `${String(event.key.id)} ${event.changed.join(',')}`
        : event.op,
    );
  };
  {
    using baseline = durableBaseline(path, host);
    await using _run = await watched(baseline, 'the baseline', t.signal);
    await baseline.commit();
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

test('while the owner keeps its WAL, each pass gives the changes of each table that its frames touched, a new table, and a dropped one', async (t) => {
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
  using host = hostOf(dir.path);
  using feed = durable(path, host);
  await using run = await watched(feed, 'the first reads', t.signal);
  const ops = async (sql: string) => {
    await feed.commit();
    owner.exec(sql);
    return (await nextBatch(run.batches, sql, t.signal)).map((event) =>
      event.op === 'truncate'
        ? `${event.table} truncate`
        : `${event.table} ${event.op} ${String(Object.values(event.key)[0])}`,
    );
  };

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

test('changes that a WAL reset removed while the feed was stopped come at the next run, with the changes after the reset', async (t) => {
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
  using host = hostOf(dir.path);
  {
    using feed = durable(path, host);
    await using _run = await watched(feed, 'the first reads', t.signal);
    await feed.commit();
  }
  owner.exec(`UPDATE a SET v = 'x2' WHERE id = 1;
    PRAGMA wal_checkpoint(TRUNCATE);`);
  // One commit for each row: the new WAL has more frames than the old one,
  // so only its salt tells that it is a new WAL.
  const insert = owner.prepare('INSERT INTO b VALUES (?, ?)');
  for (let id = 2; id <= 41; id++) insert.run(id, 'z');

  using feed = durable(path, host);
  await using run = await watched(
    feed,
    'the changes around the reset',
    t.signal,
  );

  const tables = byTable(run.first);
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

test('an update of a row whose text spills onto overflow pages comes from the frames of its leaf page', async (t) => {
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
  using host = hostOf(dir.path);
  using feed = durable(path, host);
  await using run = await watched(feed, 'the first reads', t.signal);
  await feed.commit();

  owner.exec(`UPDATE notes SET body = '${large('b')}' WHERE id = 1`);
  const batch = await nextBatch(
    run.batches,
    'the update of the large note',
    t.signal,
  );

  assert.deepEqual(
    batch.map((event) => (event.op === 'update' ? event.changed : event.op)),
    [['body']],
  );
});

test('a second feed of the stream fences the first: the commit of the first rejects with CheckpointFencedError and runs no write', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using _owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  using host = hostOf(dir.path);
  using older = durable(path, host);
  await using _older = await watched(older, 'the read of note 1', t.signal);
  using newer = durable(path, host);
  await using _newer = await watched(newer, 'the read of note 1', t.signal);
  let wrote = false;

  await assert.rejects(
    older.commit({
      write: () => {
        wrote = true;
        return undefined;
      },
    }),
    CheckpointFencedError,
  );

  assert.equal(wrote, false);
});

test('a feed that is built but never watched claims nothing, so it does not fence the feed that watches', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using _owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  using host = hostOf(dir.path);
  const group = new ConsumerGroup(
    'host',
    new SqliteCheckpointStore({ database: host }),
  );
  using feed = durable(path, host);
  await using _run = await watched(feed, 'the read of note 1', t.signal);
  using _idle = durable(path, host);

  await feed.commit();

  assert.deepEqual(await checkpointsOf(group), ['owner 1']);
});

test('a commit whose write throws commits nothing: the store keeps the earlier checkpoint, and the next run gives the batch again', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  using host = hostOf(dir.path);
  host.exec('CREATE TABLE journal (note INTEGER)');
  const group = new ConsumerGroup(
    'host',
    new SqliteCheckpointStore({ database: host }),
  );
  {
    using feed = durable(path, host);
    await using run = await watched(feed, 'the read of note 1', t.signal);
    await feed.commit();
    owner.exec("INSERT INTO notes VALUES (2, 'b')");
    await nextBatch(run.batches, 'the insert of note 2', t.signal);
    await assert.rejects(
      feed.commit({
        write: (database) => {
          database.exec('INSERT INTO journal VALUES (2)');
          throw new Error('the write failed');
        },
      }),
      /the write failed/,
    );
  }
  const kept = await checkpointsOf(group);
  const journal = host.prepare('SELECT note FROM journal').all();

  using feed = durable(path, host);
  await using again = await watched(
    feed,
    'the insert of note 2 again',
    t.signal,
  );

  assert.deepEqual(kept, ['owner 1']);
  assert.deepEqual(journal, []);
  assert.deepEqual(again.first, [
    {
      table: 'notes',
      op: 'insert',
      key: { id: 2n },
      after: { id: 2n, title: 'b' },
    },
  ]);
});

test('a commit before the feed gave a batch rejects with a TypeError', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using _owner = owned(path, 'CREATE TABLE notes (id INTEGER PRIMARY KEY)');
  using host = hostOf(dir.path);
  using feed = durable(path, host);

  await assert.rejects(feed.commit(), TypeError);
});

void test.each(
  [
    {
      name: 'another version',
      version: 2,
      json: { salt: 'a', frames: 1 },
    },
    { name: 'another shape', version: 1, json: { frames: 'many' } },
  ],
  (stored) =>
    test(`a checkpoint whose position has ${stored.name} makes the watch reject with IncompatibleCheckpointError`, async () => {
      await using dir = await new TemporaryFiles().directory('changefeed-');
      const path = join(dir.path, 'owner.sqlite');
      using _owner = owned(path, 'CREATE TABLE notes (id INTEGER PRIMARY KEY)');
      using host = hostOf(dir.path);
      const other: Format<Json> = {
        version: stored.version,
        encode: (json) => json,
        decode: (_version, json) => json,
      };
      const context = await new ConsumerGroup(
        'host',
        new SqliteCheckpointStore({ database: host }),
      ).claim({ stream, partition: '0' }, other);
      await context.commit(stored.json);
      using feed = durable(path, host);

      await assert.rejects(
        feed
          .watch({
            clock: globalThis,
            interval: 5,
            signal: new AbortController().signal,
          })
          .next(),
        (error: unknown) => {
          assert.ok(error instanceof IncompatibleCheckpointError);
          assert.equal(error.version, stored.version);
          return true;
        },
      );
    }),
);

// A store over the memory store that keeps the state changes of each commit.
class RecordingStore implements CheckpointStore<never> {
  readonly commits: StateChanges[] = [];
  readonly #store = new MemoryCheckpointStore();
  readonly claim: CheckpointStore<never>['claim'] = (key, options) =>
    this.#store.claim(key, options);
  readonly read: CheckpointStore<never>['read'] = (key, options) =>
    this.#store.read(key, options);
  readonly get: CheckpointStore<never>['get'] = (key, state, keys, options) =>
    this.#store.get(key, state, keys, options);
  readonly scan: CheckpointStore<never>['scan'] = (key, state, options) =>
    this.#store.scan(key, state, options);
  readonly list: CheckpointStore<never>['list'] = (group, options) =>
    this.#store.list(group, options);
  readonly reset: CheckpointStore<never>['reset'] = (group, target, options) =>
    this.#store.reset(group, target, options);
  readonly commit: CheckpointStore<never>['commit'] = async (
    key,
    epoch,
    checkpoint,
    changes,
    options,
  ) => {
    await this.#store.commit(key, epoch, checkpoint, changes, options);
    this.commits.push(changes);
  };
}

test('a commit keeps the WAL progress of its last pass as the position of the checkpoint', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using _owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  const group = new ConsumerGroup('host', new MemoryCheckpointStore());
  {
    using feed = new Changefeed(path, {
      checkpoints: group,
      stream,
      start: new ReadEveryRow(),
    });
    await using _run = await watched(feed, 'the reads of notes', t.signal);
    await feed.commit();
  }

  // The host reads the stored position as JSON, as another reader of the
  // checkpoint would.
  const raw: Format<{ readonly salt: Json; readonly frames: Json } | null> = {
    version: 1,
    encode: (position) => position,
    decode: (_version, json) =>
      typeof json === 'object' &&
      json !== null &&
      'salt' in json &&
      'frames' in json
        ? { salt: json.salt, frames: json.frames }
        : null,
  };
  const kept = await group.claim({ stream, partition: '0' }, raw);

  const position = kept.checkpoint?.position;
  assert.equal(typeof position?.salt, 'string');
  assert.ok(
    typeof position?.frames === 'number' && position.frames > 0,
    `the position is ${JSON.stringify(position)}`,
  );
});

// The number of keys of each map state in one kind of change of a commit.
function sizes(
  changes: ReadonlyMap<
    string,
    ReadonlyMap<string, unknown> | ReadonlySet<string>
  >,
) {
  return Object.fromEntries(
    [...changes].map(([state, keys]) => [state, keys.size]),
  );
}

void test.each(
  [
    {
      change: "INSERT INTO notes VALUES (4, 'd')",
      set: { 'table:notes': 1 },
      deleted: {},
    },
    {
      change: "UPDATE notes SET title = 'B' WHERE id = 2",
      set: { 'table:notes': 1 },
      deleted: {},
    },
    {
      change: 'DELETE FROM notes WHERE id = 3',
      set: {},
      deleted: { 'table:notes': 1 },
    },
  ],
  ({ change, set, deleted }) =>
    test(`a commit after "${change}" writes only the fingerprint of that row`, async (t) => {
      await using dir = await new TemporaryFiles().directory('changefeed-');
      const path = join(dir.path, 'owner.sqlite');
      using owner = owned(
        path,
        `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
         INSERT INTO notes VALUES (1, 'a'), (2, 'b'), (3, 'c');`,
      );
      const store = new RecordingStore();
      using feed = new Changefeed(path, {
        checkpoints: new ConsumerGroup('host', store),
        stream,
        start: new ReadEveryRow(),
      });
      await using run = await watched(feed, 'the reads of notes', t.signal);
      await feed.commit();
      owner.exec(change);
      await nextBatch(run.batches, change, t.signal);

      await feed.commit();
      // A new watch diffs the owner against what the commits kept: a wrong
      // key or a wrong fingerprint would give an event. A row that comes and
      // goes puts notes in the WAL frames, so the pass reads it again; an
      // UPDATE to the same values writes no frame.
      owner.exec(
        "INSERT INTO notes VALUES (9, 'z'); DELETE FROM notes WHERE id = 9;",
      );
      await using again = await watched(feed, 'the next run', t.signal);

      assert.deepEqual(
        store.commits.map((commit) => ({
          cleared: [...commit.cleared],
          set: sizes(commit.set),
          deleted: sizes(commit.deleted),
        })),
        [
          {
            cleared: [],
            set: { tables: 1, 'table:notes': 3 },
            deleted: {},
          },
          { cleared: [], set, deleted },
        ],
      );
      assert.deepEqual(again.first, []);
    }),
);

test('a commit with an aborted signal rejects with its reason and commits nothing, so the next run gives the batch again', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using _owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  using host = hostOf(dir.path);
  const reason = new Error('the host stopped');
  {
    using feed = durable(path, host);
    await using _run = await watched(feed, 'the read of note 1', t.signal);
    await assert.rejects(
      feed.commit({ signal: AbortSignal.abort(reason) }),
      (error: unknown) => error === reason,
    );
  }

  using feed = durable(path, host);
  await using again = await watched(feed, 'the read of note 1 again', t.signal);

  assert.deepEqual(again.first, [
    {
      table: 'notes',
      op: 'read',
      key: { id: 1n },
      after: { id: 1n, title: 'a' },
    },
  ]);
});

test('a commit with a write commits the rows of the write and the checkpoint together', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  const hostPath = join(dir.path, 'host.sqlite');
  {
    using host = hostOf(dir.path);
    host.exec('CREATE TABLE journal (events INTEGER)');
    using feed = durable(path, host);
    await using run = await watched(feed, 'the read of note 1', t.signal);
    await feed.commit({
      write: (database) =>
        void database
          .prepare('INSERT INTO journal VALUES (?)')
          .run(run.first.length),
    });
  }
  owner.exec("INSERT INTO notes VALUES (2, 'b')");

  using host = sqliteOpen.open(hostPath);
  const journal = host
    .prepare('SELECT events FROM journal')
    .all()
    .map(({ events }) => events);
  using feed = durable(path, host);
  await using run = await watched(feed, 'the insert of note 2', t.signal);

  assert.deepEqual(journal, [1]);
  assert.deepEqual(run.first, [
    {
      table: 'notes',
      op: 'insert',
      key: { id: 2n },
      after: { id: 2n, title: 'b' },
    },
  ]);
});

test('a feed whose checkpoint is in memory takes no write', async () => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using _owner = owned(path, 'CREATE TABLE notes (id INTEGER PRIMARY KEY)');
  using feed = observing(path);

  await assert.rejects(
    feed.commit({
      // @ts-expect-error The memory store has no transaction for a write.
      write: () => undefined,
    }),
    TypeError,
  );
});

test('a dropped table loses its fingerprints and its columns: a table that the owner creates again with that name gives reads at the next run, and later only its own changes', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE drafts (id INTEGER PRIMARY KEY, body TEXT);
     INSERT INTO drafts VALUES (1, 'draft');`,
  );
  using host = hostOf(dir.path);
  {
    using feed = durable(path, host);
    await using run = await watched(feed, 'the read of draft 1', t.signal);
    await feed.commit();
    owner.exec('DROP TABLE drafts');
    await nextBatch(run.batches, 'the truncate of drafts', t.signal);
    await feed.commit();
  }
  owner.exec(`CREATE TABLE drafts (id INTEGER PRIMARY KEY, body TEXT);
    INSERT INTO drafts VALUES (2, 'draft');`);

  using feed = durable(path, host);
  await using run = await watched(feed, 'the read of draft 2', t.signal);
  await feed.commit();
  owner.exec("INSERT INTO drafts VALUES (3, 'draft')");
  const later = await nextBatch(run.batches, 'the insert of draft 3', t.signal);

  assert.deepEqual(run.first, [
    {
      table: 'drafts',
      op: 'read',
      key: { id: 2n },
      after: { id: 2n, body: 'draft' },
    },
  ]);
  assert.deepEqual(later, [
    {
      table: 'drafts',
      op: 'insert',
      key: { id: 3n },
      after: { id: 3n, body: 'draft' },
    },
  ]);
});

test('one commit after several batches saves them all: a later pass of the run does not give an earlier batch again, and a new run gives neither', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  using host = hostOf(dir.path);
  const second = await (async () => {
    using feed = durable(path, host);
    await using run = await watched(feed, 'the read of note 1', t.signal);
    owner.exec("INSERT INTO notes VALUES (2, 'b')");
    const batch = await nextBatch(
      run.batches,
      'the insert of note 2',
      t.signal,
    );
    await feed.commit();
    return batch;
  })();

  using feed = durable(path, host);
  await using run = await watched(feed, 'the first pass', t.signal);

  assert.deepEqual(second, [
    {
      table: 'notes',
      op: 'insert',
      key: { id: 2n },
      after: { id: 2n, title: 'b' },
    },
  ]);
  assert.deepEqual(run.first, []);
});

test('the feed does not close the store of the host: after the feed is disposed, the consumer group still lists its checkpoint', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using _owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  using host = hostOf(dir.path);
  const group = new ConsumerGroup(
    'host',
    new SqliteCheckpointStore({ database: host }),
  );
  {
    using feed = new Changefeed(path, {
      checkpoints: group,
      stream,
      start: new ReadEveryRow(),
    });
    await using _run = await watched(feed, 'the read of note 1', t.signal);
    await feed.commit();
  }

  assert.deepEqual(await checkpointsOf(group), ['owner 1']);
});

test('a feed of another stream, and a feed of another consumer group, on the same store neither fence the feed nor share its checkpoint', async (t) => {
  await using dir = await new TemporaryFiles().directory('changefeed-');
  const path = join(dir.path, 'owner.sqlite');
  using _owner = owned(
    path,
    `CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
     INSERT INTO notes VALUES (1, 'a');`,
  );
  using host = hostOf(dir.path);
  const store = new SqliteCheckpointStore({ database: host });
  const feedOf = (group: string, name: string) =>
    new Changefeed(path, {
      checkpoints: new ConsumerGroup(group, store),
      stream: name,
      start: new ReadEveryRow(),
    });
  using feed = feedOf('host', stream);
  await using _run = await watched(feed, 'the read of note 1', t.signal);
  await feed.commit();
  using otherStream = feedOf('host', 'copy');
  await using streamRun = await watched(
    otherStream,
    'the read of note 1 of another stream',
    t.signal,
  );
  using otherGroup = feedOf('mirror', stream);
  await using groupRun = await watched(
    otherGroup,
    'the read of note 1 of another group',
    t.signal,
  );

  await feed.commit();

  const read = [
    {
      table: 'notes',
      op: 'read',
      key: { id: 1n },
      after: { id: 1n, title: 'a' },
    },
  ];
  assert.deepEqual(streamRun.first, read);
  assert.deepEqual(groupRun.first, read);
  assert.deepEqual(await checkpointsOf(new ConsumerGroup('host', store)), [
    'owner 2',
  ]);
});
