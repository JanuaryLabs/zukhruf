import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

import { open } from '@zukhruf/sqlite-open';

import { SqliteBM25Retriever, SqlitePassageStore } from '../sqlite.ts';
import {
  type KeywordPassage,
  keywordContractSchema,
  writeKeywordContract,
} from '../testing/keyword-contract.ts';
import { RecordingMetadata } from '../testing/recording-metadata.ts';

function contract(passages: readonly KeywordPassage[]): DatabaseSync {
  const database = open(':memory:');
  writeKeywordContract(database, passages);
  return database;
}

// The value of FTS5's own ranking function, which the score negates.
const engineBm25 = (database: DatabaseSync, match: string) =>
  database
    .prepare(
      `SELECT p.id, bm25(docs_passages_fts) AS bm25 FROM docs_passages_fts JOIN docs_passages p ON p.rowid = docs_passages_fts.rowid WHERE docs_passages_fts MATCH ?`,
    )
    .all(match)
    .map(({ id, bm25 }) => [id, -Number(bm25)]);

const ids = (
  results: readonly { readonly passage: { readonly id: string } }[],
) => results.map(({ passage }) => passage.id);

test('the passages come best first with -bm25() as the score, so a better match has a higher score, and a tie goes to the smaller id', async () => {
  // Arrange
  using database = contract([
    { id: 'c', text: 'signing certificates expire' },
    { id: 'k2', text: 'rotate the signing key' },
    { id: 'b', text: 'rotate key key key' },
    { id: 'k1', text: 'rotate the signing key' },
    { id: 'd', text: 'nothing here at all' },
  ]);
  const retriever = new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
  });

  // Act
  const results = (await retriever.retrieve('rotate key')).passages;

  // Assert
  assert.deepEqual(ids(results), ['b', 'k1', 'k2']);
  assert.deepEqual(
    results.map(({ passage, score }) => [passage.id, score]),
    engineBm25(database, 'rotate key').toSorted(
      ([a, x], [b, y]) =>
        Number(y) - Number(x) || String(a).localeCompare(String(b)),
    ),
  );
  assert.ok(results.every(({ score }) => (score ?? 0) > 0));
  assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 0));
  assert.deepEqual(results[1]?.passage, {
    id: 'k1',
    text: 'rotate the signing key',
    source: 'doc-k1',
    seq: 0,
    start: 0,
    end: 22,
    metadata: { product: null },
  });
});

test('passages that are a view with an integer rowid column are searched through that rowid, and the rowid is not metadata', async () => {
  // Arrange: the rowid of the keywords is in another order than their ids.
  using database = open(':memory:');
  database.exec(`
    ${keywordContractSchema}
    INSERT INTO docs_parts VALUES ('doc-a', 0, 0, 13, 'compile C code', 'gcc'), ('doc-b', 0, 0, 21, 'fix a broken git repo', 'git');
    INSERT INTO docs_keywords VALUES (70, 'a', 'doc-a', 0, 'compile C code'), (30, 'b', 'doc-b', 0, 'fix a broken git repo');
  `);
  const retriever = new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
  });

  // Act
  const git = (await retriever.retrieve('git')).passages;
  const compile = (await retriever.retrieve('compile')).passages;

  // Assert
  assert.deepEqual(
    git.map(({ passage }) => passage),
    [
      {
        id: 'b',
        text: 'fix a broken git repo',
        source: 'doc-b',
        seq: 0,
        start: 0,
        end: 21,
        metadata: { product: 'git' },
      },
    ],
  );
  assert.deepEqual(ids(compile), ['a']);
});

test('the words of the query join with AND by default and under matching { operator: AND }, and with OR under matching { operator: OR }', async () => {
  // Arrange
  using database = contract([
    { id: 'both', text: 'rotate the signing key' },
    { id: 'rotate', text: 'rotate logs daily' },
    { id: 'signing', text: 'signing certificates' },
    { id: 'neither', text: 'nothing here' },
  ]);
  const options = {
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
  };

  // Act
  const and = (
    await new SqliteBM25Retriever(options).retrieve('rotate signing')
  ).passages;
  const explicitAnd = (
    await new SqliteBM25Retriever({
      ...options,
      matching: { operator: 'AND' },
    }).retrieve('rotate signing')
  ).passages;
  const or = (
    await new SqliteBM25Retriever({
      ...options,
      matching: { operator: 'OR' },
    }).retrieve('rotate signing')
  ).passages;

  // Assert
  assert.deepEqual(ids(and), ['both']);
  assert.deepEqual(ids(explicitAnd), ['both']);
  assert.deepEqual(ids(or).toSorted(), ['both', 'rotate', 'signing']);
  assert.equal(ids(or)[0], 'both');
});

test('keywords are matched in place of the words of query, and the words of query when the bundle has no keywords, as when the query is a string', async () => {
  // Arrange
  using database = contract([
    { id: 'both', text: 'rotate the signing key' },
    { id: 'renew', text: 'renew the certificate' },
  ]);
  const retriever = new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
  });

  // Act
  const byKeywords = (
    await retriever.retrieve({
      query: 'renew certificate',
      keywords: ['rotate', 'signing key'],
    })
  ).passages;
  const byQuery = (await retriever.retrieve({ query: 'renew certificate' }))
    .passages;
  const byString = (await retriever.retrieve('renew certificate')).passages;

  // Assert: 'signing key' is one phrase, which 'both' holds.
  assert.deepEqual(ids(byKeywords), ['both']);
  assert.deepEqual(ids(byQuery), ['renew']);
  assert.deepEqual(byString, byQuery);
});

test('each keyword is one phrase, so its words match side by side and in order, under AND and under OR, while each word of a text matches anywhere', async () => {
  // Arrange: 'reversed' and 'apart' hold every word of the keywords, but
  // not side by side in their order.
  using database = contract([
    { id: 'hf', text: 'chronic heart failure in adults' },
    { id: 'reversed', text: 'failure of the heart muscle' },
    { id: 'ace', text: 'an ACE inhibitor lowers pressure' },
    { id: 'both', text: 'heart failure treated with an ACE inhibitor' },
    { id: 'apart', text: 'failure of the heart and an inhibitor of ACE' },
  ]);
  const options = {
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
  };
  const and = new SqliteBM25Retriever(options);
  const or = new SqliteBM25Retriever({
    ...options,
    matching: { operator: 'OR' },
  });
  const keywords = ['heart failure', 'ACE inhibitor'] as const;

  // Act
  const results = {
    one: ids(
      (await and.retrieve({ query: 'hf', keywords: ['heart failure'] }))
        .passages,
    ),
    and: ids((await and.retrieve({ query: 'hf', keywords })).passages),
    or: ids((await or.retrieve({ query: 'hf', keywords })).passages),
    text: ids((await and.retrieve('heart failure')).passages),
  };

  // Assert
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(results).map(([name, found]) => [name, found.toSorted()]),
    ),
    {
      one: ['both', 'hf'],
      and: ['both'],
      or: ['ace', 'both', 'hf'],
      text: ['apart', 'both', 'hf', 'reversed'],
    },
  );
});

test('a keyword with FTS5 syntax in it is one phrase of text: its OR, quotes and hyphen are part of the phrase and never run as operators', async () => {
  // Arrange
  using database = contract([
    { id: 'or', text: 'heart or failure' },
    { id: 'reversed', text: 'failure or heart' },
    { id: 'hf', text: 'heart failure' },
  ]);
  const retriever = new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
  });
  const byKeyword = async (keyword: string) =>
    ids(
      (await retriever.retrieve({ query: 'q', keywords: [keyword] })).passages,
    );

  // Act
  const results = {
    // As FTS5, OR would join heart and failure and match every passage.
    or: await byKeyword('heart OR failure'),
    // Not doubled, the quotes would end the phrase and run OR.
    quotes: await byKeyword('heart" OR "failure'),
    // Unquoted, `-` opens a column filter: "no such column: failure".
    hyphen: await byKeyword('heart-failure'),
  };

  // Assert
  assert.deepEqual(results, {
    or: ['or'],
    quotes: ['or'],
    hyphen: ['hf'],
  });
});

test('each word of the query is a phrase, so FTS5 syntax in it matches as text and never runs as an operator', async () => {
  // Arrange
  using database = contract([
    { id: 'hyphen', text: 'the key-rotation runbook' },
    { id: 'column', text: 'text: see the title' },
    { id: 'quote', text: 'she said hi' },
    { id: 'near', text: 'stay near key points' },
    { id: 'or', text: 'this or that' },
  ]);
  const retriever = new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
  });

  // Act
  const results = {
    // Unquoted, `-` opens a column filter: "no such column: rotation".
    hyphen: ids((await retriever.retrieve('key-rotation')).passages),
    // Unquoted, `text:` filters the column text.
    column: ids((await retriever.retrieve('text: title')).passages),
    // A `"` in a word is doubled, so it cannot end the phrase.
    quote: ids((await retriever.retrieve('said "hi"')).passages),
    near: ids((await retriever.retrieve('NEAR(key points)')).passages),
    // Unquoted, OR would join "this" and "nothing" and match.
    or: ids((await retriever.retrieve('this OR nothing')).passages),
    orAlone: ids((await retriever.retrieve('or')).passages),
    star: ids((await retriever.retrieve('*')).passages),
    // Not doubled, the quotes would close the phrase and run OR: "nothing"OR"key".
    closingQuote: ids((await retriever.retrieve('nothing"OR"key')).passages),
  };

  // Assert
  assert.deepEqual(results, {
    hyphen: ['hyphen'],
    column: ['column'],
    quote: ['quote'],
    near: ['near'],
    or: [],
    orAlone: ['or'],
    star: [],
    closingQuote: [],
  });
});

test('a query of no words gives no passages', async () => {
  // Arrange
  using database = contract([{ id: 'a', text: 'rotate the key' }]);
  const retriever = new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
  });

  // Act
  const results = (await retriever.retrieve(' \t\n ')).passages;

  // Assert
  assert.deepEqual(results, []);
});

test('keywords of no words reject with a RangeError that names keywords, since a blank keyword is a caller bug and not an empty search', async () => {
  // Arrange
  using database = contract([{ id: 'a', text: 'rotate the key' }]);
  const retriever = new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
  });

  // Act
  const result = retriever.retrieve({
    query: 'rotate the key',
    keywords: ['  '],
  });

  // Assert
  await assert.rejects(result, {
    name: 'RangeError',
    message: 'The keywords of a query bundle hold no word: got ["  "]',
  });
});

test('a keyword search gives 10 passages when the call gives no topK, topK when it gives one, and only the passages its filter selects', async () => {
  // Arrange
  using database = contract(
    Array.from({ length: 12 }, (_, i) => ({
      id: `p${String(i).padStart(2, '0')}`,
      text: 'rotate the key',
      product: i % 2 === 0 ? 'vault' : 'consul',
    })),
  );
  const retriever = new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
  });

  // Act
  const byDefault = (await retriever.retrieve('key')).passages;
  const two = (await retriever.retrieve('key', { topK: 2 })).passages;
  const filtered = (
    await retriever.retrieve('key', {
      filter: {
        operator: 'AND',
        conditions: [
          { field: 'metadata.product', operator: '==', value: 'consul' },
          { field: 'source', operator: 'not in', value: ['doc-p01'] },
        ],
      },
    })
  ).passages;

  // Assert
  assert.deepEqual(
    ids(byDefault),
    Array.from({ length: 10 }, (_, i) => `p${String(i).padStart(2, '0')}`),
  );
  assert.deepEqual(ids(two), ['p00', 'p01']);
  assert.deepEqual(ids(filtered), ['p03', 'p05', 'p07', 'p09', 'p11']);
});

test('an aborted keyword search rejects with the reason of its signal', async () => {
  // Arrange
  using database = contract([{ id: 'a', text: 'rotate the key' }]);
  const retriever = new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
  });
  const reason = new Error('cancelled');

  // Act
  const result = retriever.retrieve('key', {
    signal: AbortSignal.abort(reason),
  });

  // Assert
  await assert.rejects(result, (error) => error === reason);
});

test('a passages relation and an index whose names need quoting are searched by those names', async () => {
  // Arrange
  using database = open(':memory:');
  database.exec(`
    CREATE TABLE "docs ""keywords""" (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, seq INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, text TEXT NOT NULL) STRICT;
    CREATE VIRTUAL TABLE "docs ""fts""" USING fts5(text, content = 'docs "keywords"');
    CREATE TRIGGER "docs ""keywords"" ai" AFTER INSERT ON "docs ""keywords""" BEGIN INSERT INTO "docs ""fts""" (rowid, text) VALUES (new.rowid, new.text); END;
    CREATE VIEW "docs ""passages""" AS SELECT rowid AS rowid, id, source, seq, start, "end", text FROM "docs ""keywords""";
    INSERT INTO "docs ""keywords""" (id, source, seq, start, "end", text) VALUES ('a', 's', 0, 0, 14, 'rotate the key');
  `);
  const retriever = new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs "passages"',
      metadata: (columns) => columns,
    }),
    index: 'docs "fts"',
  });

  // Act
  const results = (await retriever.retrieve('key')).passages;

  // Assert
  assert.deepEqual(ids(results), ['a']);
});

test('the metadata of each passage is what the metadata of its store reads from the other columns of its row, through retrieve and a filter on it', async () => {
  // Arrange
  using database = contract([
    { id: 'k', text: 'rotate the key', product: 'kms' },
    { id: 'v', text: 'rotate the vault key', product: 'vault' },
  ]);
  const metadata = new RecordingMetadata(({ product }) => {
    if (product !== 'kms' && product !== 'vault') {
      throw new TypeError(
        `A passage is of kms or vault, not ${String(product)}`,
      );
    }
    return { product };
  });
  const retriever = new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: metadata.read,
    }),
    index: 'docs_passages_fts',
  });

  // Act
  const all = (await retriever.retrieve('rotate key')).passages;
  const vault = (
    await retriever.retrieve('rotate key', {
      filter: { field: 'metadata.product', operator: '==', value: 'vault' },
    })
  ).passages;

  // Assert
  const passages = [...all, ...vault].map(({ passage }) => passage);
  assert.deepEqual(
    passages.map(({ id, metadata }) => [id, metadata]),
    [
      ['k', { product: 'kms' }],
      ['v', { product: 'vault' }],
      ['v', { product: 'vault' }],
    ],
  );
  assert.ok(passages.every((passage) => metadata.gave(passage.metadata)));
  // The rowid that the index joins on is no metadata column (ADR 0004).
  assert.deepEqual(metadata.columns[0], { product: 'kms' });
});

test('a matching operator other than AND or OR is refused with a RangeError when the retriever is made', () => {
  // Arrange
  using database = contract([]);
  const store = new SqlitePassageStore({
    database,
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });

  // Act
  const make = () =>
    new SqliteBM25Retriever({
      store,
      index: 'docs_passages_fts',
      // @ts-expect-error: a JavaScript caller can pass any operator
      matching: { operator: 'XOR' },
    });

  // Assert
  assert.throws(
    make,
    new RangeError("The operator of matching is 'AND' or 'OR', not XOR"),
  );
});
