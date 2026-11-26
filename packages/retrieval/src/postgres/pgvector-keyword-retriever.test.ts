import assert from 'node:assert/strict';
import { addAbortListener } from 'node:events';

import type pg from 'pg';

import { test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';

import {
  PgvectorKeywordRetriever,
  type PostgresMatching,
  PostgresPassageStore,
  type PostgresSession,
} from '../postgres.ts';
import { RecordingMetadata } from '../testing/recording-metadata.ts';

type Row = {
  readonly id: string;
  readonly text: string;
  readonly source?: string;
  readonly product?: string;
};

const server = () =>
  new Postgres({ environment: process.env, image: 'pgvector/pgvector:pg18' });

// The passages and the keyword index as elt writes them: a tsvector column
// of the passages, generated from the text with a text search configuration
// (english unless the test names another), and a GIN index on it.
async function contract(
  pool: pg.Pool,
  rows: readonly Row[],
  configuration = 'english',
): Promise<void> {
  await pool.query(`
    CREATE TABLE docs_passages (id text PRIMARY KEY, source text NOT NULL, seq integer NOT NULL, start integer NOT NULL, "end" integer NOT NULL, text text NOT NULL, product text, keywords tsvector GENERATED ALWAYS AS (to_tsvector('${configuration}', text)) STORED);
    CREATE INDEX docs_passages_keywords ON docs_passages USING GIN (keywords);
  `);
  for (const row of rows) {
    await pool.query(
      'INSERT INTO docs_passages VALUES ($1, $2, 0, 0, $3, $4, $5)',
      [
        row.id,
        row.source ?? `doc-${row.id}`,
        row.text.length,
        row.text,
        row.product ?? null,
      ],
    );
  }
}

// The session a host writes over node-postgres, as the README shows.
const session = (pool: pg.Pool): PostgresSession => ({
  query: async (sql, parameters) =>
    (await pool.query(sql, [...parameters])).rows,
});

const ids = (
  results: readonly { readonly passage: { readonly id: string } }[],
) => results.map(({ passage }) => passage.id);

test("under matching { strategy: 'all' } the passages come best first with ts_rank_cd as the score, so a better match has a higher score, and a tie goes to the smaller id in byte order", async () => {
  // Arrange: `K` sorts before `k` in byte order, and after it in the en_US
  // collation of the server.
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'c', text: 'signing certificates expire' },
    { id: 'k', text: 'rotate the signing key' },
    { id: 'b', text: 'rotate key key key' },
    { id: 'K', text: 'rotate the signing key' },
    { id: 'd', text: 'nothing here at all' },
  ]);
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: { column: 'keywords' },
    matching: { strategy: 'all' },
  });

  // Act
  const results = (await retriever.retrieve('rotate key')).passages;

  // Assert
  // The value of Postgres's own ranking function for the same query.
  const { rows: engine } = await pool.query<{ id: string; rank: number }>(
    `SELECT id, ts_rank_cd(keywords, plainto_tsquery('english', 'rotate key')) AS rank FROM docs_passages WHERE keywords @@ plainto_tsquery('english', 'rotate key')`,
  );
  assert.deepEqual(ids(results), ['b', 'K', 'k']);
  assert.deepEqual(
    results.map(({ passage, score }) => [passage.id, score]),
    ['b', 'K', 'k'].map((id) => [
      id,
      engine.find((row) => row.id === id)?.rank,
    ]),
  );
  assert.ok(results.every(({ score }) => (score ?? 0) > 0));
  assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 0));
  assert.deepEqual(results[1]?.passage, {
    id: 'K',
    text: 'rotate the signing key',
    source: 'doc-K',
    seq: 0,
    start: 0,
    end: 22,
    metadata: { product: null },
  });
});

test("the words of the query join with AND under matching { strategy: 'all' }, and by default, where AND matches fewer than 10 passages, the most frequent word is dropped", async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'both', text: 'rotate the signing key' },
    { id: 'rotate', text: 'rotate logs daily' },
    { id: 'signing', text: 'signing certificates' },
    { id: 'neither', text: 'nothing here' },
  ]);
  const options = {
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: { column: 'keywords' },
  };

  // Act
  const byDefault = (
    await new PgvectorKeywordRetriever(options).retrieve('rotate signing')
  ).passages;
  const all = (
    await new PgvectorKeywordRetriever({
      ...options,
      matching: { strategy: 'all' },
    }).retrieve('rotate signing')
  ).passages;

  // Assert: 'rotate' and 'signing' are each in 2 passages; the tie drops
  // 'signing', whose lexeme sorts after 'rotat'.
  assert.deepEqual(ids(all), ['both']);
  assert.deepEqual(ids(byDefault), ['both', 'rotate']);
});

test('keywords are matched in place of the words of query, and the words of query when the bundle has no keywords, as when the query is a string', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'both', text: 'rotate the signing key' },
    { id: 'renew', text: 'renew the certificate' },
  ]);
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: { column: 'keywords' },
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

  // Assert: 'signing key' is one phraseto_tsquery, which 'both' holds.
  assert.deepEqual(ids(byKeywords), ['both']);
  assert.deepEqual(ids(byQuery), ['renew']);
  assert.deepEqual(byString, byQuery);
});

test('each keyword is one phrase, so its lexemes match side by side and in order, while each word of a text matches anywhere', async () => {
  // Arrange: 'reversed' and 'apart' hold every lexeme of the keywords, but
  // not side by side in their order.
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'hf', text: 'chronic heart failure in adults' },
    { id: 'reversed', text: 'failure of the heart muscle' },
    { id: 'ace', text: 'an ACE inhibitor lowers pressure' },
    { id: 'both', text: 'heart failure treated with an ACE inhibitor' },
    { id: 'apart', text: 'failure of the heart and an inhibitor of ACE' },
  ]);
  // Under AND, every keyword must match, so a keyword split into words
  // would change what matches.
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: { column: 'keywords' },
    matching: { strategy: 'all' },
  });

  // Act
  const results = {
    one: ids(
      (await retriever.retrieve({ query: 'hf', keywords: ['heart failure'] }))
        .passages,
    ),
    // The english configuration stems the phrase: failures is failure.
    stemmed: ids(
      (await retriever.retrieve({ query: 'hf', keywords: ['heart failures'] }))
        .passages,
    ),
    two: ids(
      (
        await retriever.retrieve({
          query: 'hf',
          keywords: ['heart failure', 'ACE inhibitor'],
        })
      ).passages,
    ),
    text: ids((await retriever.retrieve('heart failure')).passages),
  };

  // Assert
  assert.deepEqual(
    Object.fromEntries(
      Object.entries(results).map(([name, found]) => [name, found.toSorted()]),
    ),
    {
      one: ['both', 'hf'],
      stemmed: ['both', 'hf'],
      two: ['both'],
      text: ['apart', 'both', 'hf', 'reversed'],
    },
  );
});

test('a keyword with tsquery syntax in it is one phrase of plain text: its operators never run', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'hf', text: 'chronic heart failure' },
    { id: 'reversed', text: 'failure of the heart' },
    { id: 'heart', text: 'a healthy heart' },
  ]);
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: { column: 'keywords' },
  });
  const byKeyword = async (keyword: string) =>
    ids(
      (await retriever.retrieve({ query: 'q', keywords: [keyword] })).passages,
    ).toSorted();

  // Act
  const results = {
    // As tsquery, `|` is heart or failure: every passage.
    or: await byKeyword('heart | failure'),
    // As tsquery, `& !` is heart and not failure: 'heart'.
    andNot: await byKeyword('heart & !failure'),
    // As tsquery, `<3>` is failure three positions before heart: 'reversed'.
    distance: await byKeyword('failure <3> heart'),
  };

  // Assert
  assert.deepEqual(results, {
    or: ['hf'],
    andNot: ['hf'],
    distance: [],
  });
});

test('the query and the index use the english configuration: a word finds its other forms, and a stop word neither matches nor stops a match', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'rotate', text: 'rotate the key' },
    { id: 'other', text: 'vault keeps secrets' },
  ]);
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: { column: 'keywords' },
  });

  // Act
  const results = {
    stem: ids((await retriever.retrieve('rotating keys')).passages),
    // "the" and "a" are english stop words: they leave no word to match.
    stopWordsOnly: ids((await retriever.retrieve('the a')).passages),
    // "of" is dropped, so the AND of the other words still matches.
    stopWordInside: ids((await retriever.retrieve('rotate of key')).passages),
  };

  // Assert
  assert.deepEqual(results, {
    stem: ['rotate'],
    stopWordsOnly: [],
    stopWordInside: ['rotate'],
  });
});

test('the configuration of the index value reaches the query: with simple, a stop word matches and a word finds no other form', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(
    pool,
    [
      { id: 'the', text: 'the key' },
      { id: 'rotate', text: 'rotate logs' },
    ],
    'simple',
  );
  const store = new PostgresPassageStore({
    session: session(pool),
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });
  const simple = new PgvectorKeywordRetriever({
    store,
    index: { column: 'keywords', configuration: 'simple' },
  });
  const english = new PgvectorKeywordRetriever({
    store,
    index: { column: 'keywords' },
  });

  // Act
  const results = {
    // simple keeps "the"; english drops it from the query.
    simpleStopWord: ids((await simple.retrieve('the')).passages),
    englishStopWord: ids((await english.retrieve('the')).passages),
    // simple does not stem, so "rotating" is not "rotate".
    simpleStem: ids((await simple.retrieve('rotating')).passages),
    simpleWord: ids((await simple.retrieve('rotate')).passages),
  };

  // Assert
  assert.deepEqual(results, {
    simpleStopWord: ['the'],
    englishStopWord: [],
    simpleStem: [],
    simpleWord: ['rotate'],
  });
});

test('a configuration is a value, never SQL: a configuration that would change the query as SQL is refused as the name of a configuration', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'vault', text: 'vault keeps secrets' },
    { id: 'consul', text: 'consul keeps services' },
  ]);
  // A configuration name with SQL syntax in it. The retriever binds it as a
  // parameter, so Postgres refuses it as a name before it reads any row.
  const hostile =
    "english', 'x') || to_tsquery('english', 'vault') || plainto_tsquery('english";
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: { column: 'keywords', configuration: hostile },
  });

  // Act
  const result = retriever.retrieve('consul');

  // Assert: Postgres reads the parameter as a regconfig name and refuses
  // its syntax, 42602 invalid_name, so no SQL of the value runs.
  await assert.rejects(result, {
    code: '42602',
    message: 'invalid name syntax',
  });
});

test('each word of the query is plain text, so tsquery syntax in it matches as text and never runs as an operator', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'hyphen', text: 'the key-rotation runbook' },
    { id: 'vault', text: 'vault keeps secrets' },
    { id: 'consul', text: 'consul keeps services' },
    { id: 'keystone', text: 'keystone service' },
  ]);
  // Under AND, a word that runs as an operator would change what matches.
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: { column: 'keywords' },
    matching: { strategy: 'all' },
  });

  // Act
  const results = {
    hyphen: ids((await retriever.retrieve('key-rotation')).passages),
    // As tsquery, `!vault` is every passage without vault.
    not: ids((await retriever.retrieve('!vault')).passages),
    // As tsquery, `vault|consul` is vault or consul.
    or: ids((await retriever.retrieve('vault|consul')).passages),
    // As tsquery, `&` joins and `!` negates: consul and not vault.
    andNot: ids((await retriever.retrieve('consul&!vault')).passages),
    // As tsquery, `key:*` is every word that starts with key.
    prefix: ids((await retriever.retrieve('key:*')).passages),
    // As tsquery, `<->` needs secrets right before vault.
    phrase: ids((await retriever.retrieve('secrets<->vault')).passages),
    // As tsquery, an open quote or parenthesis is a syntax error.
    quote: ids((await retriever.retrieve("vault'")).passages),
    parenthesis: ids((await retriever.retrieve('(vault')).passages),
  };

  // Assert
  assert.deepEqual(results, {
    hyphen: ['hyphen'],
    not: ['vault'],
    or: [],
    andNot: [],
    prefix: ['hyphen'],
    phrase: ['vault'],
    quote: ['vault'],
    parenthesis: ['vault'],
  });
});

test('a query of no words gives no passages', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [{ id: 'a', text: 'rotate the key' }]);
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: { column: 'keywords' },
  });

  // Act
  const results = (await retriever.retrieve(' \t\n ')).passages;

  // Assert
  assert.deepEqual(results, []);
});

test('a keyword search gives 10 passages when the call gives no topK, topK when it gives one, and only the passages its filter selects', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(
    pool,
    Array.from({ length: 12 }, (_, i) => ({
      id: `p${String(i).padStart(2, '0')}`,
      text: 'rotate the key',
      product: i % 2 === 0 ? 'vault' : 'consul',
    })),
  );
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: { column: 'keywords' },
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
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [{ id: 'a', text: 'rotate the key' }]);
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: { column: 'keywords' },
  });
  const reason = new Error('cancelled');

  // Act
  const result = retriever.retrieve('key', {
    signal: AbortSignal.abort(reason),
  });

  // Assert
  await assert.rejects(result, (error) => error === reason);
});

test('the search reads the index column that the retriever names, by a name that needs quoting, and no tsvector column is metadata', async () => {
  // Arrange: the index holds other words than the text, as an index that
  // elt fills from another column would.
  await using database = await server().database();
  const pool = database.pool();
  await pool.query(`
    CREATE TABLE "docs ""passages""" (id text PRIMARY KEY, source text NOT NULL, seq integer NOT NULL, start integer NOT NULL, "end" integer NOT NULL, text text NOT NULL, "key ""words""" tsvector NOT NULL, other tsvector);
    INSERT INTO "docs ""passages""" VALUES ('a', 's', 0, 0, 14, 'rotate the key', to_tsvector('english', 'vault secrets'), to_tsvector('english', 'rotate'));
  `);
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs "passages"',
      metadata: (columns) => columns,
    }),
    index: { column: 'key "words"' },
  });

  // Act
  const byIndex = (await retriever.retrieve('secrets')).passages;
  const byText = (await retriever.retrieve('rotate')).passages;

  // Assert
  assert.deepEqual(
    byIndex.map(({ passage }) => passage),
    [
      {
        id: 'a',
        text: 'rotate the key',
        source: 's',
        seq: 0,
        start: 0,
        end: 14,
        metadata: {},
      },
    ],
  );
  assert.deepEqual(byText, []);
});

test('passages that are a view over the table that holds the index are searched through the view', async () => {
  // Arrange: elt gives the passages with the metadata of their source row
  // through a view.
  await using database = await server().database();
  const pool = database.pool();
  await pool.query(`
    CREATE TABLE docs_parts (id text PRIMARY KEY, source text NOT NULL, seq integer NOT NULL, start integer NOT NULL, "end" integer NOT NULL, text text NOT NULL, keywords tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED);
    CREATE INDEX ON docs_parts USING GIN (keywords);
    CREATE TABLE docs_sources (source text PRIMARY KEY, product text NOT NULL);
    CREATE VIEW docs_passages AS SELECT p.*, s.product FROM docs_parts p JOIN docs_sources s USING (source);
    INSERT INTO docs_sources VALUES ('doc-a', 'gcc'), ('doc-b', 'git');
    INSERT INTO docs_parts VALUES ('a', 'doc-a', 0, 0, 14, 'compile C code'), ('b', 'doc-b', 0, 0, 21, 'fix a broken git repo');
  `);
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: { column: 'keywords' },
  });

  // Act
  const git = (
    await retriever.retrieve('git', {
      filter: { field: 'metadata.product', operator: '==', value: 'git' },
    })
  ).passages;

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
});

test('a store with a schema searches the keyword index of the passages of that schema, and a store without one finds them through the search_path of the session', async () => {
  // Arrange: the same contract in public, which the search_path finds, and
  // in a second schema, each with passages and a keyword index of its own.
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [{ id: 'public-a', text: 'rotate the key' }]);
  await pool.query(`
    CREATE SCHEMA rag;
    CREATE TABLE rag.docs_passages (LIKE public.docs_passages INCLUDING ALL);
    INSERT INTO rag.docs_passages (id, source, seq, start, "end", text) VALUES ('rag-a', 'doc-rag-a', 0, 0, 14, 'rotate the key');
  `);
  const retriever = (store: PostgresPassageStore) =>
    new PgvectorKeywordRetriever({ store, index: { column: 'keywords' } });

  // Act
  const fromSchema = (
    await retriever(
      new PostgresPassageStore({
        session: session(pool),
        schema: 'rag',
        passages: 'docs_passages',
        metadata: (columns) => columns,
      }),
    ).retrieve('key')
  ).passages;
  const fromSearchPath = (
    await retriever(
      new PostgresPassageStore({
        session: session(pool),
        passages: 'docs_passages',
        metadata: (columns) => columns,
      }),
    ).retrieve('key')
  ).passages;

  // Assert: the keyword column of the schema's passages is not metadata.
  assert.deepEqual(
    fromSchema.map(({ passage }) => passage),
    [
      {
        id: 'rag-a',
        text: 'rotate the key',
        source: 'doc-rag-a',
        seq: 0,
        start: 0,
        end: 14,
        metadata: { product: null },
      },
    ],
  );
  assert.deepEqual(ids(fromSearchPath), ['public-a']);
});

test('two stores on two databases, alive at once, each search the keyword index of their own session', async () => {
  // Arrange: both stores exist before either retriever, and their rows differ.
  await using first = await server().database();
  await using second = await server().database();
  await contract(first.pool(), [{ id: 'first-a', text: 'rotate the key' }]);
  await contract(second.pool(), [{ id: 'second-a', text: 'rotate the key' }]);
  const firstStore = new PostgresPassageStore({
    session: session(first.pool()),
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });
  const secondStore = new PostgresPassageStore({
    session: session(second.pool()),
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });
  const fromFirst = new PgvectorKeywordRetriever({
    store: firstStore,
    index: { column: 'keywords' },
  });
  const fromSecond = new PgvectorKeywordRetriever({
    store: secondStore,
    index: { column: 'keywords' },
  });

  // Act
  const firstResults = (await fromFirst.retrieve('key')).passages;
  const secondResults = (await fromSecond.retrieve('key')).passages;

  // Assert
  assert.deepEqual(ids(firstResults), ['first-a']);
  assert.deepEqual(ids(secondResults), ['second-a']);
});

test('the metadata of each passage is what the metadata of its store reads from the other columns of its row, without the tsvector of the index, through retrieve and a filter on it', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
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
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: metadata.read,
    }),
    index: { column: 'keywords' },
  });

  // Act
  const all = (await retriever.retrieve('rotate key')).passages;
  const vault = (
    await retriever.retrieve('rotate key', {
      filter: { field: 'metadata.product', operator: 'in', value: ['vault'] },
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
  assert.deepEqual(metadata.columns[0], { product: 'kms' });
});

test("the keyword search passes the call's signal to the session, which cancels the running query on the server, and the call rejects with the signal's reason", async (t) => {
  // Arrange: a host session that cancels its query with pg_cancel_backend,
  // as the README shows; it records the cancel and the code of each error.
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [{ id: 'a', text: 'rotate the key' }]);
  const cancels: Promise<unknown>[] = [];
  const codes: unknown[] = [];
  const cancelling: PostgresSession = {
    query: async (sql, parameters, { signal } = {}) => {
      const client = await pool.connect();
      let cancelled: Promise<unknown> | undefined;
      try {
        const [backend] = (await client.query('SELECT pg_backend_pid() AS pid'))
          .rows;
        const cancel = () => {
          cancelled = pool.query('SELECT pg_cancel_backend($1)', [
            backend?.pid,
          ]);
          cancels.push(cancelled);
        };
        using _listening =
          signal === undefined ? undefined : addAbortListener(signal, cancel);
        try {
          const { rows } = await client.query(sql, [...parameters]);
          signal?.throwIfAborted();
          return rows;
        } catch (error) {
          codes.push(
            Error.isError(error) && 'code' in error ? error.code : error,
          );
          signal?.throwIfAborted();
          throw error;
        }
      } finally {
        try {
          await cancelled;
        } finally {
          client.release();
        }
      }
    },
  };
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: cancelling,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: { column: 'keywords' },
  });
  // A transaction that holds the table, so the search waits on its lock
  // until the session cancels it.
  const locker = await pool.connect();
  try {
    await locker.query(
      'BEGIN; LOCK TABLE docs_passages IN ACCESS EXCLUSIVE MODE',
    );
    const controller = new AbortController();
    const reason = new Error('the caller left');

    // Act
    const result = retriever.retrieve('key', { signal: controller.signal });
    const settled = result.then(
      () => undefined,
      (error: unknown) => error,
    );
    await waitFor(
      async () => {
        const { rows } = await pool.query(
          `SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`,
        );
        assert.equal(rows.length, 1);
      },
      { signal: t.signal },
    );
    controller.abort(reason);
    // A session that got no signal cancels nothing: the commit below then
    // lets the search answer, and the assertion fails.
    await Promise.all(cancels);
    await locker.query('COMMIT');

    // Assert
    assert.equal(await settled, reason);
    assert.deepEqual(codes, ['57014']);
  } finally {
    locker.release();
  }
});

test("a matching strategy other than 'all' or 'frequency' is refused with a RangeError when the retriever is made", () => {
  // Arrange
  const store = new PostgresPassageStore({
    session: { query: () => Promise.reject(new Error('no query runs')) },
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });

  // Act
  const make = () =>
    new PgvectorKeywordRetriever({
      store,
      index: { column: 'keywords' },
      // @ts-expect-error: Postgres has no OR (ADR 0018)
      matching: { strategy: 'any' },
    });

  // Assert
  assert.throws(
    make,
    new RangeError("The strategy of matching is 'all' or 'frequency', not any"),
  );
});

// A keyword retriever over the contract's index, with the matching and the
// configuration given.
const keywordsOf = (
  pool: pg.Pool,
  matching?: PostgresMatching,
  configuration?: string,
) =>
  new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: {
      column: 'keywords',
      ...(configuration === undefined ? {} : { configuration }),
    },
    ...(matching === undefined ? {} : { matching }),
  });

test("by default, a question that AND answers with at least 10 passages gives AND's passages in AND's order", async () => {
  // Arrange: passage n has n words between 'rotate' and 'key', and every
  // passage has 14 words, so a passage whose words are closer is the better
  // match under either ranking.
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    ...Array.from({ length: 12 }, (_, n) => ({
      id: `p${String(n + 1).padStart(2, '0')}`,
      text: [
        'rotate',
        ...Array.from({ length: n + 1 }, () => 'filler'),
        'key',
        ...Array.from({ length: 11 - n }, () => 'filler'),
      ].join(' '),
    })),
    { id: 'rotate', text: 'rotate logs' },
    { id: 'key', text: 'a signing key' },
  ]);

  // Act
  const byDefault = (
    await keywordsOf(pool).retrieve('rotate key', { topK: 20 })
  ).passages;
  const and = (
    await keywordsOf(pool, { strategy: 'all' }).retrieve('rotate key', {
      topK: 20,
    })
  ).passages;

  // Assert
  assert.equal(and.length, 12);
  assert.deepEqual(ids(byDefault), ids(and));
});

test('by default, a question with a word that no passage holds still finds the passages of its other words', async () => {
  // Arrange
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    { id: 'r1', text: 'rotate the key' },
    { id: 'r2', text: 'rotate logs' },
    { id: 'k', text: 'signing key' },
  ]);

  // Act
  const results = (await keywordsOf(pool).retrieve('rotate zzyzx')).passages;

  // Assert
  assert.deepEqual(ids(results).toSorted(), ['r1', 'r2']);
});

test('by default, where AND matches fewer than 10 passages, the most frequent word is dropped first, by the statistics of the column after ANALYZE and by a count of each word before it, and a passage that holds more of the words ranks first', async () => {
  // Arrange: 'dose' is in 30 passages, 'renal' in 14, 'apixaban' in 12.
  // All three are in 2 passages; without 'dose', 12 match. The question
  // names 'apixaban' last, so a drop by position would keep 'dose'.
  await using database = await server().database();
  const pool = database.pool();
  const numbered = (prefix: string, count: number, text: string) =>
    Array.from({ length: count }, (_, n) => ({
      id: `${prefix}${String(n + 1).padStart(2, '0')}`,
      text,
    }));
  await contract(pool, [
    ...numbered('a', 2, 'apixaban renal dose'),
    ...numbered('b', 10, 'apixaban renal'),
    ...numbered('r', 2, 'renal dose'),
    ...numbered('d', 26, 'dose'),
  ]);
  const retriever = keywordsOf(pool);
  const statistics = async () =>
    (
      await pool.query<{ lexemes: string[] | null }>(
        `SELECT (SELECT most_common_elems::text::text[] FROM pg_stats WHERE tablename = 'docs_passages' AND attname = 'keywords') AS lexemes`,
      )
    ).rows[0]?.lexemes;

  // Act
  const before = ids(
    (await retriever.retrieve('renal dose of apixaban', { topK: 20 })).passages,
  );
  const withoutStatistics = await statistics();
  await pool.query('ANALYZE docs_passages');
  const after = ids(
    (await retriever.retrieve('renal dose of apixaban', { topK: 20 })).passages,
  );

  // Assert
  assert.equal(withoutStatistics, null);
  assert.deepEqual((await statistics())?.toSorted(), [
    'apixaban',
    'dose',
    'renal',
  ]);
  const expected = [
    'a01',
    'a02',
    ...Array.from(
      { length: 10 },
      (_, n) => `b${String(n + 1).padStart(2, '0')}`,
    ),
  ];
  assert.deepEqual(before, expected);
  assert.deepEqual(after, expected);
});

test("by default, a doctor's 'or', '-' and quotes are words of the question, never operators", async () => {
  // Arrange: the simple configuration keeps 'or' as a word.
  await using database = await server().database();
  const pool = database.pool();
  await contract(
    pool,
    [
      { id: 'x', text: 'heart or failure' },
      { id: 'y', text: 'heart failure' },
      { id: 'z', text: 'heart' },
    ],
    'simple',
  );

  // Act: as websearch_to_tsquery, this is 'heart' OR NOT 'failure': 'z'.
  const results = (
    await keywordsOf(pool, undefined, 'simple').retrieve('"heart" or -failure')
  ).passages;

  // Assert: 'or' is the rarest word, and 'x' holds it.
  assert.deepEqual(ids(results), ['x']);
});

test("by default, the score is the number of the question's words that a passage holds plus ts_rank with normalization 33 against the OR of its words, so a passage that holds more of them ranks first", async () => {
  // Arrange: 'fewer' is short and repeats its words, so ts_rank alone ranks
  // it above 'more', which holds every word of the question.
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [
    {
      id: 'more',
      text: 'apixaban for renal impairment: the dose and the storage, handling and disposal of the tablets',
    },
    { id: 'fewer', text: 'apixaban dose, apixaban dose' },
    { id: 'r1', text: 'renal function' },
    { id: 'r2', text: 'renal failure' },
    { id: 'd1', text: 'dose missed' },
    { id: 'd2', text: 'dose adjusted' },
    { id: 'd3', text: 'dose timing' },
  ]);

  // Act
  const results = (await keywordsOf(pool).retrieve('apixaban renal dose'))
    .passages;

  // Assert
  const { rows: engine } = await pool.query<{ id: string; rank: number }>(
    `SELECT id, ts_rank(keywords, to_tsquery('english', 'apixaban | renal | dose'), 33)::float8 AS rank FROM docs_passages WHERE id IN ('more', 'fewer')`,
  );
  const rank = (id: string) => engine.find((row) => row.id === id)?.rank ?? 0;
  assert.ok(rank('fewer') > rank('more'));
  assert.deepEqual(
    results.map(({ passage, score }) => [passage.id, score]),
    [
      ['more', 3 + rank('more')],
      ['fewer', 2 + rank('fewer')],
    ],
  );
});

test('a dropTokensThreshold that is not a positive finite number is refused with a RangeError when the retriever is made', () => {
  // Arrange
  const store = new PostgresPassageStore({
    session: { query: () => Promise.reject(new Error('no query runs')) },
    passages: 'docs_passages',
    metadata: (columns) => columns,
  });
  const values = [0, -1, Number.NaN, Number.POSITIVE_INFINITY];

  for (const value of values) {
    // Act
    const make = () =>
      new PgvectorKeywordRetriever({
        store,
        index: { column: 'keywords' },
        matching: { strategy: 'frequency', dropTokensThreshold: value },
      });

    // Assert
    assert.throws(
      make,
      new RangeError(
        `The dropTokensThreshold of matching is a positive finite number, not ${String(value)}`,
      ),
    );
  }
});

test('by default, on a column whose statistics track 1,000 lexemes, every statement reads the passages through the GIN index, for a word that the statistics do not track and for words they do, only a word they do not track is counted, and each drop is one statement', async () => {
  // Arrange: 20,000 passages of 30 words of a skewed vocabulary, on a
  // server of their own. VACUUM empties the pending list of the GIN index,
  // as autovacuum does on a live table; ANALYZE tracks the 1,000 most
  // common lexemes, so 'apixaban' and 'zzyzx' are not tracked.
  await using database = await new Postgres({
    environment: process.env,
    image: 'pgvector/pgvector:pg18',
    tmpFs: { '/var/lib/postgresql': 'rw,size=256m' },
  }).start();
  const pool = database.pool();
  await contract(pool, [
    { id: 'rare1', text: 'apixaban v3' },
    { id: 'rare2', text: 'apixaban v5' },
  ]);
  await pool.query(`
    INSERT INTO docs_passages (id, source, seq, start, "end", text)
    SELECT 'g' || g, 'generated', g, 0, 0, (
      SELECT string_agg('v' || floor(power(((g * 7919 + j * 104729) % 10007) / 10007.0, 3) * 5000)::int, ' ')
      FROM generate_series(1, 30) AS j)
    FROM generate_series(1, 20000) AS g`);
  await pool.query('VACUUM ANALYZE docs_passages');
  const {
    rows: [tracked],
  } = await pool.query<{ lexemes: string[] }>(
    `SELECT most_common_elems::text::text[] AS lexemes FROM pg_stats WHERE tablename = 'docs_passages' AND attname = 'keywords'`,
  );
  // The plan of each statement the retriever sends, as the nodes that read
  // the passages, from EXPLAIN of the statement with its parameters.
  const plans: string[][] = [];
  const reads = (node: Record<string, unknown>): string[] => {
    const children = node['Plans'];
    return [
      ...(node['Relation Name'] === 'docs_passages'
        ? [String(node['Node Type'])]
        : []),
      ...(Array.isArray(children) ? children.flatMap(reads) : []),
    ];
  };
  const explaining: PostgresSession = {
    query: async (sql, parameters) => {
      const { rows } = await pool.query(`EXPLAIN (FORMAT JSON) ${sql}`, [
        ...parameters,
      ]);
      plans.push(reads(rows[0]['QUERY PLAN'][0]['Plan']));
      return (await pool.query(sql, [...parameters])).rows;
    },
  };
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: explaining,
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: { column: 'keywords' },
  });

  // Act
  const untracked = (await retriever.retrieve('apixaban zzyzx v3 v5')).passages;
  const untrackedPlans = plans.splice(0);
  const common = (await retriever.retrieve('v3 v5')).passages;
  const commonPlans = plans.splice(0);

  // Assert
  assert.equal(tracked?.lexemes.length, 1000);
  assert.ok(tracked?.lexemes.includes('v3') && tracked.lexemes.includes('v5'));
  assert.ok(!tracked?.lexemes.includes('apixaban'));
  assert.deepEqual(ids(untracked), ['rare1', 'rare2']);
  assert.equal(common.length, 10);
  assert.ok(common.every(({ score }) => Number.isFinite(score)));
  // The words, the count of the untracked words, AND of all three held
  // words, AND without 'v3', then the ranking of 'apixaban'.
  assert.deepEqual(untrackedPlans, [
    [],
    ['Bitmap Heap Scan', 'Bitmap Heap Scan'],
    ['Bitmap Heap Scan'],
    ['Bitmap Heap Scan'],
    ['Bitmap Heap Scan'],
  ]);
  // The words, AND of both, then its ranking: no word is counted.
  assert.deepEqual(commonPlans, [
    [],
    ['Bitmap Heap Scan'],
    ['Bitmap Heap Scan'],
  ]);
});

test('by default, passages that are a view read the statistics of the table that holds the index column, so after ANALYZE no word that the statistics track is counted', async () => {
  // Arrange: elt's view over the table of the index, with 'dose' in 30
  // parts, 'renal' in 14 and 'apixaban' in 12, as the statistics after
  // ANALYZE of the table track them. A view has no statistics of its own.
  await using database = await server().database();
  const pool = database.pool();
  await pool.query(`
    CREATE TABLE docs_parts (id text PRIMARY KEY, source text NOT NULL, seq integer NOT NULL, start integer NOT NULL, "end" integer NOT NULL, text text NOT NULL, keywords tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED);
    CREATE INDEX ON docs_parts USING GIN (keywords);
    CREATE TABLE docs_sources (source text PRIMARY KEY, product text NOT NULL);
    CREATE VIEW docs_passages AS SELECT p.*, s.product FROM docs_parts p JOIN docs_sources s USING (source);
    INSERT INTO docs_sources VALUES ('doc', 'gcc');
    INSERT INTO docs_parts (id, source, seq, start, "end", text)
    SELECT prefix || lpad(n::text, 2, '0'), 'doc', 0, 0, 0, text
    FROM (VALUES ('a', 2, 'apixaban renal dose'), ('b', 10, 'apixaban renal'), ('r', 2, 'renal dose'), ('d', 26, 'dose')) AS v(prefix, count, text),
      generate_series(1, count) AS n;
    ANALYZE docs_parts;
  `);
  const statements: string[] = [];
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: {
        query: async (sql, parameters) => {
          statements.push(sql);
          return (await pool.query(sql, [...parameters])).rows;
        },
      },
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: { column: 'keywords' },
  });

  // Act
  const results = (
    await retriever.retrieve('renal dose of apixaban', { topK: 20 })
  ).passages;

  // Assert
  const {
    rows: [tracked],
  } = await pool.query<{ lexemes: string[] }>(
    `SELECT most_common_elems::text::text[] AS lexemes FROM pg_stats WHERE tablename = 'docs_parts' AND attname = 'keywords'`,
  );
  assert.deepEqual(tracked?.lexemes.toSorted(), ['apixaban', 'dose', 'renal']);
  assert.deepEqual(ids(results), [
    'a01',
    'a02',
    ...Array.from(
      { length: 10 },
      (_, n) => `b${String(n + 1).padStart(2, '0')}`,
    ),
  ]);
  // The words, AND of all three, AND without 'dose', then the ranking: no
  // word is counted.
  assert.equal(statements.length, 4);
});

test("by default, the call's filter selects the passages that the AND is counted in, so a two-word question whose AND the filter brings below 10 passages drops its most frequent word", async () => {
  // Arrange: 'rotate' is in 17 passages and 'key' in 16. AND matches 14
  // passages, 2 of them git's.
  await using database = await server().database();
  const pool = database.pool();
  const numbered = (prefix: string, count: number, text: string) =>
    Array.from({ length: count }, (_, n) => ({
      id: `${prefix}${String(n + 1).padStart(2, '0')}`,
      text,
      product: prefix.startsWith('git') ? 'git' : 'gcc',
    }));
  await contract(pool, [
    ...numbered('gcc', 12, 'rotate the key'),
    ...numbered('git-both', 2, 'rotate the key'),
    ...numbered('git-key', 2, 'signing key'),
    ...numbered('git-rotate', 3, 'rotate logs'),
  ]);

  // Act
  const results = (
    await keywordsOf(pool).retrieve('rotate key', {
      topK: 20,
      filter: { field: 'metadata.product', operator: '==', value: 'git' },
    })
  ).passages;

  // Assert: without 'rotate', git's passages that hold 'key', those that
  // hold both first.
  assert.deepEqual(ids(results), [
    'git-both01',
    'git-both02',
    'git-key01',
    'git-key02',
  ]);
});

test('by default, a question whose AND matches exactly 10 passages keeps every word', async () => {
  // Arrange: 'rotate' is in 13 passages and 'key' in 15; AND matches 10.
  await using database = await server().database();
  const pool = database.pool();
  const numbered = (prefix: string, count: number, text: string) =>
    Array.from({ length: count }, (_, n) => ({
      id: `${prefix}${String(n + 1).padStart(2, '0')}`,
      text,
    }));
  await contract(pool, [
    ...numbered('both', 10, 'rotate the key'),
    ...numbered('rotate', 3, 'rotate logs'),
    ...numbered('key', 5, 'signing key'),
  ]);

  // Act
  const results = (await keywordsOf(pool).retrieve('rotate key', { topK: 20 }))
    .passages;

  // Assert
  assert.deepEqual(
    ids(results),
    Array.from(
      { length: 10 },
      (_, n) => `both${String(n + 1).padStart(2, '0')}`,
    ),
  );
});

void test.each([-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY], (topK) =>
  test(`a topK of ${topK} in the call is a RangeError before any statement reaches the session, as Elasticsearch refuses a bad size`, async () => {
    // Arrange: a session that records each statement.
    const statements: string[] = [];
    const retriever = new PgvectorKeywordRetriever({
      store: new PostgresPassageStore({
        session: {
          query: async (sql) => {
            statements.push(sql);
            return [];
          },
        },
        passages: 'docs_passages',
        metadata: (columns) => columns,
      }),
      index: { column: 'keywords' },
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
  await using database = await server().database();
  const pool = database.pool();
  await contract(pool, [{ id: 'k', text: 'rotate the signing key' }]);
  const retriever = new PgvectorKeywordRetriever({
    store: new PostgresPassageStore({
      session: session(pool),
      passages: 'docs_passages',
      metadata: (columns) => columns,
    }),
    index: { column: 'keywords' },
  });

  // Act
  const result = await retriever.retrieve('rotate key', { topK: 0 });

  // Assert
  assert.deepEqual(result.passages, []);
});
