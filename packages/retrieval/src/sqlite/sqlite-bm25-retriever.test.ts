import assert from 'node:assert/strict';
import { type DatabaseSync, constants } from 'node:sqlite';

import { test } from '@zukhruf/parameterized-test';
import { open } from '@zukhruf/sqlite-open';

import {
  SqliteBM25Retriever,
  type SqliteMatching,
  SqlitePassageStore,
} from '../sqlite.ts';
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

test('the words of the query join with OR by default and under matching { operator: OR }, where no word is in more than 20,000 passages, and with AND under matching { operator: AND }', async () => {
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
  const byDefault = (
    await new SqliteBM25Retriever(options).retrieve('rotate signing')
  ).passages;
  const and = (
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
  assert.deepEqual(ids(or).toSorted(), ['both', 'rotate', 'signing']);
  assert.equal(ids(or)[0], 'both');
  assert.deepEqual(byDefault, or);
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
  const and = new SqliteBM25Retriever({
    ...options,
    matching: { operator: 'AND' },
  });
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
  // Under AND, a word that runs as an operator would change what matches.
  const retriever = new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
    matching: { operator: 'AND' },
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

void test.each(
  [
    [
      { entrez: 'term' },
      'The query of a query bundle is not a string: got undefined',
    ],
    [
      { query: 'rotate the key', keywords: ['rotate', 7] },
      'The keywords of a query bundle are not a list of strings: got ["rotate",7]',
    ],
    [
      { query: 'rotate the key', keywords: 'rotate' },
      'The keywords of a query bundle are not a list of strings: got "rotate"',
    ],
  ] as const,
  ([bundle, message]) =>
    test(`${JSON.stringify(bundle)}, from a caller with no types, rejects with a RangeError, since a keyword search matches text only`, async () => {
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
      // @ts-expect-error: a caller with no types passes a bundle with no string query
      const result = retriever.retrieve(bundle);

      // Assert
      await assert.rejects(result, { name: 'RangeError', message });
    }),
);

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

// A keyword retriever over the contract's index, with the matching given.
const keywordsOf = (database: DatabaseSync, matching?: SqliteMatching) =>
  new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
    ...(matching === undefined ? {} : { matching }),
  });

test('a question with a word that no passage holds still finds the passages of its other words, by default and when its other words are all common', async () => {
  // Arrange
  using database = contract([
    { id: 'r1', text: 'rotate the key' },
    { id: 'r2', text: 'rotate logs' },
    { id: 'k', text: 'signing key' },
  ]);

  // Act
  const byDefault = (await keywordsOf(database).retrieve('rotate zzyzx'))
    .passages;
  // 'rotate' is in 2 passages, so with a cutoff of 1 it is common.
  const common = (
    await keywordsOf(database, {
      operator: 'OR',
      cutoffFrequency: 1,
    }).retrieve('rotate zzyzx')
  ).passages;

  // Assert
  assert.deepEqual(ids(byDefault).toSorted(), ['r1', 'r2']);
  assert.deepEqual(ids(common).toSorted(), ['r1', 'r2']);
});

test('with a count cutoffFrequency, a passage that holds only words in more passages than the cutoff is not returned while a passage with a rarer word is, and a common word raises the score of the passage that holds it', async () => {
  // Arrange: 'dose' is in 4 passages, 'apixaban' in 2; r1 and r2 have the
  // same length, so only 'dose' can tell their scores apart.
  using database = contract([
    { id: 'r1', text: 'apixaban dose' },
    { id: 'r2', text: 'apixaban twice' },
    { id: 'c1', text: 'dose adjusted' },
    { id: 'c2', text: 'dose missed' },
    { id: 'c3', text: 'dose timing' },
  ]);

  // Act
  const results = (
    await keywordsOf(database, {
      operator: 'OR',
      cutoffFrequency: 2,
    }).retrieve('apixaban dose')
  ).passages;
  const or = (
    await keywordsOf(database, { operator: 'OR' }).retrieve('apixaban dose')
  ).passages;

  // Assert
  assert.deepEqual(ids(results), ['r1', 'r2']);
  assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 0));
  assert.ok(results.every(({ score }) => Number.isFinite(score)));
  assert.deepEqual(ids(or).toSorted(), ['c1', 'c2', 'c3', 'r1', 'r2']);
});

test('a word in as many passages as cutoffFrequency is rare and a word in one more passage is common', async () => {
  // Arrange: 'twice' is in 2 passages, 'thrice' in 3.
  using database = contract([
    { id: 't1', text: 'twice thrice' },
    { id: 't2', text: 'twice' },
    { id: 'h1', text: 'thrice' },
    { id: 'h2', text: 'thrice' },
  ]);

  // Act
  const results = (
    await keywordsOf(database, {
      operator: 'OR',
      cutoffFrequency: 2,
    }).retrieve('twice thrice')
  ).passages;

  // Assert: 'twice' finds, 'thrice' only scores.
  assert.deepEqual(ids(results), ['t1', 't2']);
});

test('a query of only words in more passages than cutoffFrequency runs as their AND', async () => {
  // Arrange: 'rotate' and 'signing' are in 2 passages each.
  using database = contract([
    { id: 'both', text: 'rotate the signing key' },
    { id: 'rotate', text: 'rotate logs daily' },
    { id: 'signing', text: 'signing certificates' },
  ]);

  // Act
  const results = (
    await keywordsOf(database, {
      operator: 'OR',
      cutoffFrequency: 1,
    }).retrieve('rotate signing')
  ).passages;

  // Assert
  assert.deepEqual(ids(results), ['both']);
});

test('a keyword is counted as one phrase, so a phrase in no more passages than cutoffFrequency is rare though each of its words is common', async () => {
  // Arrange: 'heart' and 'failure' are in 4 passages each, the phrase
  // 'heart failure' in 2, and 'dose' in 3.
  using database = contract([
    { id: 'p1', text: 'heart failure dose' },
    { id: 'p2', text: 'heart failure treated' },
    { id: 'p3', text: 'failure of the heart dose' },
    { id: 'p4', text: 'heart and failure dose' },
  ]);

  // Act
  const results = (
    await keywordsOf(database, {
      operator: 'OR',
      cutoffFrequency: 2,
    }).retrieve({ query: 'q', keywords: ['heart failure', 'dose'] })
  ).passages;

  // Assert
  assert.deepEqual(ids(results), ['p1', 'p2']);
});

test('a cutoffFrequency under 1 is a share of the passages that the index holds', async () => {
  // Arrange: 4 passages; 'twice' is in 2, 'thrice' in 3.
  using database = contract([
    { id: 't1', text: 'twice thrice' },
    { id: 't2', text: 'twice' },
    { id: 'h1', text: 'thrice' },
    { id: 'h2', text: 'thrice' },
  ]);
  const search = async (cutoffFrequency: number) =>
    ids(
      (
        await keywordsOf(database, {
          operator: 'OR',
          cutoffFrequency,
        }).retrieve('twice thrice')
      ).passages,
    );

  // Act
  const results = { half: await search(0.5), most: await search(0.75) };

  // Assert: half is 2 passages, so 'thrice' is common; 3 of 4 holds both.
  assert.deepEqual(results, {
    half: ['t1', 't2'],
    most: ['t1', 'h1', 'h2', 't2'],
  });
});

test('by default a word in 20,000 passages is rare and a word in 20,001 is common', async () => {
  // Arrange: 'common' is in 20,001 passages, 'edge' in 20,000, 'rare' in 2.
  using database = contract([
    { id: 'rare', text: 'rare words' },
    { id: 'rare common', text: 'rare common' },
    ...Array.from({ length: 20_000 }, (_, i) => ({
      id: `c${String(i)}`,
      text: 'common edge',
    })),
  ]);
  const retriever = keywordsOf(database);

  // Act
  const common = (await retriever.retrieve('rare common')).passages;
  const edge = (await retriever.retrieve('rare edge')).passages;

  // Assert: 'common' only adds to the score of the passages 'rare' finds;
  // 'edge' finds passages of its own, so the OR fills the 10 of topK.
  assert.deepEqual(ids(common), ['rare common', 'rare']);
  assert.equal(edge.length, 10);
});

test('a cutoffFrequency that is not a positive finite number is refused with a RangeError when the retriever is made', () => {
  // Arrange
  using database = contract([]);
  const values = [0, -1, Number.NaN, Number.POSITIVE_INFINITY];

  // Act
  const make = (cutoffFrequency: number) => () =>
    keywordsOf(database, { operator: 'OR', cutoffFrequency });

  // Assert
  for (const value of values) {
    assert.throws(
      make(value),
      new RangeError(
        `The cutoffFrequency of matching is a positive finite number, not ${String(value)}`,
      ),
    );
  }
});

void test.each([-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY], (topK) =>
  test(`a topK of ${topK} in the call is a RangeError before any statement runs, as Elasticsearch refuses a bad size`, async () => {
    // Arrange: the authorizer sees each statement that SQLite compiles.
    using database = contract([{ id: 'k', text: 'rotate the signing key' }]);
    const statements: number[] = [];
    database.setAuthorizer((action) => {
      statements.push(action);
      return constants.SQLITE_OK;
    });
    const retriever = new SqliteBM25Retriever({
      store: new SqlitePassageStore({
        database,
        passages: 'docs_passages',
        metadata: (columns) => columns,
      }),
      index: 'docs_passages_fts',
    });

    // Act
    const call = retriever.retrieve('rotate key', { topK });

    // Assert
    await assert.rejects(call, {
      name: 'RangeError',
      message: `The topK is a whole number of 0 or more, not ${topK}`,
    });
    // A length, not deepEqual: deepEqual would narrow statements to never[].
    assert.equal(statements.length, 0);
  }),
);

test("a topK of 0 in the call gives no passages, as Elasticsearch's size 0", async () => {
  // Arrange
  using database = contract([{ id: 'k', text: 'rotate the signing key' }]);
  const retriever = new SqliteBM25Retriever({
    store: new SqlitePassageStore({
      database,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: 'docs_passages_fts',
  });

  // Act
  const result = await retriever.retrieve('rotate key', { topK: 0 });

  // Assert
  assert.deepEqual(result.passages, []);
});
