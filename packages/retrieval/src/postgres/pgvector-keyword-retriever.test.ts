import assert from 'node:assert/strict';
import { addAbortListener } from 'node:events';
import { test } from 'node:test';

import type pg from 'pg';

import { waitFor } from '@zukhruf/testing/async';
import { Postgres } from '@zukhruf/testing/postgres';

import {
  PgvectorKeywordRetriever,
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

test('the passages come best first with ts_rank_cd as the score, so a better match has a higher score, and a tie goes to the smaller id in byte order', async () => {
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

test("the words of the query join with AND by default and under matching { strategy: 'all' }", async () => {
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
  const and = (
    await new PgvectorKeywordRetriever(options).retrieve('rotate signing')
  ).passages;
  const all = (
    await new PgvectorKeywordRetriever({
      ...options,
      matching: { strategy: 'all' },
    }).retrieve('rotate signing')
  ).passages;

  // Assert
  assert.deepEqual(ids(and), ['both']);
  assert.deepEqual(ids(all), ['both']);
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

test("a matching strategy other than 'all' is refused with a RangeError when the retriever is made", () => {
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
    new RangeError("The strategy of matching is 'all', not any"),
  );
});
