import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { open } from '@zukhruf/sqlite-open';

import { ContextWindow, PassageGapError } from './index.ts';
import { SqlitePassageStore } from './sqlite.ts';

const guide = 'abcdefghijklmnopqrstuvwxyz0123456789';

// The passages of the passage contract as elt writes them: the guide cut
// into parts of 6 characters every 4, so each part repeats the last 2 of the
// one before, and a short source of notes with seq 0 to 2.
function passages(): DatabaseSync {
  const database = open(':memory:');
  database.exec(
    'CREATE TABLE docs_passages (id TEXT PRIMARY KEY, source TEXT NOT NULL, seq INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, text TEXT NOT NULL, product TEXT) STRICT',
  );
  const insert = database.prepare(
    'INSERT INTO docs_passages VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  for (let seq = 0; seq < 8; seq++) {
    const start = seq * 4;
    insert.run(
      `guide-${seq}`,
      'guide',
      seq,
      start,
      start + 6,
      guide.slice(start, start + 6),
      'vault',
    );
  }
  for (let seq = 0; seq < 3; seq++) {
    insert.run(`notes-${seq}`, 'notes', seq, seq, seq + 1, `${seq}`, 'kms');
  }
  return database;
}

// The scored passages as a search gives them: read from the contract.
async function found(
  store: SqlitePassageStore,
  ids: readonly string[],
  score = 0.5,
) {
  const stored = await store.get(ids);
  return ids.flatMap((id) => {
    const passage = stored.get(id);
    return passage === undefined ? [] : [{ passage, score, vector: [1, 0] }];
  });
}

test('with the default windowSize 3 a passage takes the text of its window, merged without repeating an overlap, and keeps its id, seq, metadata, score and vector', async () => {
  // Arrange
  using database = passages();
  const store = new SqlitePassageStore({
    database,
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });
  const window = new ContextWindow({ store });

  // Act
  const results = await window.postprocess(
    await found(store, ['guide-4']),
    'rotate a key',
  );

  // Assert: seq 4 - 3 to 4 + 3 is guide-1 to guide-7, from start 4 to end
  // 34. Each part after the first adds its text past the end of the one
  // before: 'efghij' + 'klmn' + 'opqr' + ... = guide 4 to 34.
  assert.deepEqual(results, [
    {
      passage: {
        id: 'guide-4',
        text: guide.slice(4, 34),
        source: 'guide',
        seq: 4,
        start: 4,
        end: 34,
        metadata: { product: 'vault' },
      },
      score: 0.5,
      vector: [1, 0],
    },
  ]);
});

test('a window of the given windowSize stops at the edges of its source and holds only the passages of that source', async () => {
  // Arrange
  using database = passages();
  const store = new SqlitePassageStore({
    database,
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });
  const window = new ContextWindow({ store, windowSize: 1 });

  // Act
  const results = await window.postprocess(
    await found(store, ['guide-0', 'notes-2', 'guide-7']),
    'rotate a key',
  );

  // Assert: guide-0 has no part before it: guide-0 and guide-1, 0 to 10;
  // notes-2 takes notes-1 and notes-2; guide-7 takes guide-6 and guide-7,
  // 24 to 34.
  assert.deepEqual(
    results.map(({ passage }) => [
      passage.id,
      passage.text,
      passage.start,
      passage.end,
    ]),
    [
      ['guide-0', guide.slice(0, 10), 0, 10],
      ['notes-2', '12', 1, 3],
      ['guide-7', guide.slice(24, 34), 24, 34],
    ],
  );
});

test('the parts of a window merge in the order of start, and a part inside an earlier one adds nothing and does not move the end back', async () => {
  // Arrange: a source whose parts are not in the order of start, with one
  // part inside another.
  using database = passages();
  const insert = database.prepare(
    "INSERT INTO docs_passages VALUES (?, 'faq', ?, ?, ?, ?, 'vault')",
  );
  insert.run('faq-0', 0, 8, 14, 'ijklmn');
  insert.run('faq-1', 1, 0, 10, 'abcdefghij');
  insert.run('faq-2', 2, 2, 5, 'cde');
  const store = new SqlitePassageStore({
    database,
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });
  const window = new ContextWindow({ store });

  // Act
  const results = await window.postprocess(
    await found(store, ['faq-1']),
    'rotate a key',
  );

  // Assert: by start, 'abcdefghij' (0 to 10) first; 'cde' (2 to 5) adds
  // its text past 10 - 2 = 8, nothing, and the end stays 10; 'ijklmn' (8 to
  // 14) adds its text past 10 - 8 = 2, 'klmn'. The window is 0 to 14.
  assert.deepEqual(
    results.map(({ passage }) => [passage.text, passage.start, passage.end]),
    [['abcdefghijklmn', 0, 14]],
  );
});

test('the parts of a window are cut in code points, as start and end count them, so text outside the Basic Multilingual Plane merges whole', async () => {
  // Arrange: a source of 11 code points, 5 of them emoji of two UTF-16
  // units each. 'keys-0' (0 to 4) and 'keys-1' (2 to 6) share 'b🔑';
  // 'keys-2' (6 to 9) starts where 'keys-1' ends.
  using database = passages();
  const source = [...'a🔑b🔑c🗝d🔒e🔒f'];
  const insert = database.prepare(
    "INSERT INTO docs_passages VALUES (?, 'keys', ?, ?, ?, ?, 'vault')",
  );
  insert.run('keys-0', 0, 0, 4, source.slice(0, 4).join(''));
  insert.run('keys-1', 1, 2, 6, source.slice(2, 6).join(''));
  insert.run('keys-2', 2, 6, 9, source.slice(6, 9).join(''));
  const store = new SqlitePassageStore({
    database,
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });
  const window = new ContextWindow({ store });

  // Act
  const results = await window.postprocess(
    await found(store, ['keys-1']),
    'rotate a key',
  );

  // Assert: 'keys-1' adds its text past code point 4 - 2 = 2, 'c🗝', and
  // 'keys-2' adds all of its text: the code points 0 to 9 of the source.
  assert.deepEqual(
    results.map(({ passage }) => [passage.text, passage.start, passage.end]),
    [['a🔑b🔑c🗝d🔒e', 0, 9]],
  );
});

test('a window whose passages leave a gap in their source fails with PassageGapError, which names the source and the offsets of the gap', async () => {
  // Arrange: 'gap-1' (2 to 4) is inside 'gap-0' (0 to 8); 'gap-2' starts at
  // 10, so the code points 8 to 10 of the source are in no passage.
  using database = passages();
  const insert = database.prepare(
    "INSERT INTO docs_passages VALUES (?, 'gap', ?, ?, ?, ?, 'vault')",
  );
  insert.run('gap-0', 0, 0, 8, 'abcdefgh');
  insert.run('gap-1', 1, 2, 4, 'cd');
  insert.run('gap-2', 2, 10, 14, 'klmn');
  const store = new SqlitePassageStore({
    database,
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });
  const window = new ContextWindow({ store });

  // Act
  const result = window.postprocess(
    await found(store, ['gap-1']),
    'rotate a key',
  );

  // Assert
  await assert.rejects(result, (error) => {
    assert.ok(error instanceof PassageGapError);
    assert.deepEqual(
      {
        name: error.name,
        message: error.message,
        source: error.source,
        start: error.start,
        end: error.end,
      },
      {
        name: 'PassageGapError',
        message:
          'The passages of the source gap have a gap from 8 to 10: the passage contract requires that the passages of a source tile it',
        source: 'gap',
        start: 8,
        end: 10,
      },
    );
    return true;
  });
});

test('a passage that the store has no window for stays as it is', async () => {
  // Arrange
  using database = passages();
  const store = new SqlitePassageStore({
    database,
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });
  const window = new ContextWindow({ store });
  const web = {
    passage: {
      id: 'web-1',
      text: 'a page of the web',
      source: 'https://example.com',
      seq: 0,
      start: 0,
      end: 17,
      metadata: {},
    },
    score: 0.9,
  };

  // Act
  const results = await window.postprocess([web], 'rotate a key');

  // Assert
  assert.deepEqual(results, [web]);
});

test('a windowSize that is not a positive integer is refused, as Haystack refuses a window_size below 1', () => {
  // Arrange
  using database = passages();
  const store = new SqlitePassageStore({
    database,
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });

  // Act and Assert
  for (const windowSize of [0, 1.5]) {
    assert.throws(() => new ContextWindow({ store, windowSize }), {
      name: 'RangeError',
      message: `The windowSize is a positive integer, not ${windowSize}`,
    });
  }
});

test('an aborted call rejects with the reason of its signal', async () => {
  // Arrange
  using database = passages();
  const store = new SqlitePassageStore({
    database,
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });
  const window = new ContextWindow({ store });
  const controller = new AbortController();
  const reason = new Error('the caller left');
  controller.abort(reason);

  // Act and Assert
  await assert.rejects(
    window.postprocess(await found(store, ['guide-4']), 'rotate a key', {
      abortSignal: controller.signal,
    }),
    (error) => error === reason,
  );
});
