import assert from 'node:assert/strict';

import type mssql from 'mssql';

import { describe, test } from '@zukhruf/parameterized-test';
import { waitFor } from '@zukhruf/testing/async';
import { SqlServer } from '@zukhruf/testing/sqlserver';

import {
  SqlServerKeywordRetriever,
  SqlServerPassageStore,
  type SqlServerSession,
} from '../sqlserver.ts';
import { RecordingMetadata } from '../testing/recording-metadata.ts';

type Row = {
  readonly id: string;
  readonly text: string;
  readonly source?: string;
  readonly product?: string;
};

const server = () =>
  new SqlServer({
    environment: process.env,
    image: 'mcr.microsoft.com/mssql/server:2025-latest',
    fullTextSearch: true,
  });

// SQL Server 2025 crashes at start about once in 41 starts when an arm64
// engine emulates amd64 (#5469), so a test that runs it runs only where the
// engine runs amd64 natively, as on CI.
const emulation = await SqlServer.emulation({ environment: process.env });

// The passages and the keyword index as elt writes them: a full-text index
// on the text of the passages table, whose key is the binary passage id. The
// index has no stoplist unless the test names one, as SQLite FTS5 has none.
async function contract(
  pool: mssql.ConnectionPool,
  rows: readonly Row[],
  signal: AbortSignal,
  { schema = 'dbo', stoplist = 'OFF' } = {},
): Promise<void> {
  await pool
    .request()
    .batch(
      `CREATE TABLE [${schema}].docs_passages (id NVARCHAR(450) COLLATE Latin1_General_100_BIN2 NOT NULL CONSTRAINT pk_${schema}_docs_passages PRIMARY KEY, source NVARCHAR(400) NOT NULL, seq INT NOT NULL, start INT NOT NULL, [end] INT NOT NULL, text NVARCHAR(MAX) NOT NULL, product NVARCHAR(100))`,
    );
  await insert(pool, `[${schema}].docs_passages`, rows);
  await fullTextIndex(
    pool,
    `[${schema}].docs_passages`,
    `pk_${schema}_docs_passages`,
    signal,
    stoplist,
  );
}

// Each row in its own INSERT, in the order given.
async function insert(
  pool: mssql.ConnectionPool,
  table: string,
  rows: readonly Row[],
): Promise<void> {
  for (const row of rows) {
    await pool
      .request()
      .input('id', row.id)
      .input('source', row.source ?? `doc-${row.id}`)
      .input('end', row.text.length)
      .input('text', row.text)
      .input('product', row.product ?? null)
      .query(
        `INSERT INTO ${table} VALUES (@id, @source, 0, 0, @end, @text, @product)`,
      );
  }
}

async function fullTextIndex(
  pool: mssql.ConnectionPool,
  table: string,
  key: string,
  signal: AbortSignal,
  stoplist = 'OFF',
): Promise<void> {
  await pool.request().batch(`
    IF NOT EXISTS (SELECT 1 FROM sys.fulltext_catalogs WHERE name = N'docs_catalog') CREATE FULLTEXT CATALOG docs_catalog AS DEFAULT;
    CREATE FULLTEXT INDEX ON ${table} ([text] LANGUAGE 1033) KEY INDEX ${key} WITH STOPLIST = ${stoplist}, CHANGE_TRACKING AUTO;
  `);
  await populated(pool, table, signal);
}

// A full-text index fills in the background. It is ready when it has no
// population running and no change waiting (with a change waiting, the
// status is 0 before the rows are visible), and when a search for the words
// of the table finds every row: before the population starts, the status
// and the changes are 0 too.
async function populated(
  pool: mssql.ConnectionPool,
  table: string,
  signal: AbortSignal,
): Promise<void> {
  await waitFor(
    async () => {
      const { recordset } = await pool
        .request()
        .input('table', table)
        .query(
          `SELECT OBJECTPROPERTYEX(OBJECT_ID(@table), 'TableFulltextPopulateStatus') AS status, OBJECTPROPERTYEX(OBJECT_ID(@table), 'TableFulltextPendingChanges') AS pending`,
        );
      const [state] = recordset;
      assert.deepEqual([Number(state?.status), Number(state?.pending)], [0, 0]);
      const { recordset: texts } = await pool
        .request()
        .query(`SELECT text FROM ${table}`);
      const words = new Set(
        texts.flatMap(
          ({ text }) => String(text).match(/[\p{L}\p{N}]+/gu) ?? [],
        ),
      );
      if (words.size === 0) return;
      const { recordset: found } = await pool
        .request()
        .input('condition', [...words].map((word) => `"${word}"`).join(' OR '))
        .query(
          `SELECT COUNT(DISTINCT [KEY]) AS visible FROM CONTAINSTABLE(${table}, [text], @condition)`,
        );
      assert.equal(Number(found[0]?.visible), texts.length);
    },
    { signal },
  );
}

// The session a host writes over mssql, as the README shows.
const session = (pool: mssql.ConnectionPool): SqlServerSession => ({
  query: async (sql, parameters) => {
    const request = pool.request();
    for (const [name, value] of Object.entries(parameters))
      request.input(name, value);
    return (await request.query(sql)).recordset ?? [];
  },
});

const ids = (
  results: readonly { readonly passage: { readonly id: string } }[],
) => results.map(({ passage }) => passage.id);

// Each test makes its own database on the run's shared server, and a
// full-text index fills in the background in 8 to 10 s. The server fills
// several at once (six in 8.05 s, the same time as one), so the tests run at
// the same time.
describe('SqlServerKeywordRetriever', { concurrency: true }, () => {
  test(
    'under matching { predicate: CONTAINS, operator: AND } the passages come best first with RANK of CONTAINSTABLE as the score, so a better match has a higher score, and a tie goes to the smaller id in binary order',
    { skip: emulation },
    async (t) => {
      // Arrange: `K` sorts before `k` in binary order, and after it in the
      // case-insensitive collation of the server. The RANK of an AND is the
      // lower RANK of its words, so `b` holds each word twice to rank above
      // them (64 against 32 on SQL Server 2025 RTM-CU11).
      await using database = await server().database();
      const pool = await database.pool();
      await contract(
        pool,
        [
          { id: 'c', text: 'signing certificates expire' },
          { id: 'k', text: 'rotate the signing key' },
          { id: 'b', text: 'rotate key rotate key' },
          { id: 'K', text: 'rotate the signing key' },
          { id: 'd', text: 'nothing here at all' },
        ],
        t.signal,
      );
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
        matching: { predicate: 'CONTAINS', operator: 'AND' },
      });

      // Act
      const results = (await retriever.retrieve('rotate key')).passages;

      // Assert
      // The value of SQL Server's own ranking for the same condition.
      const { recordset: engine } = await pool
        .request()
        .query(
          `SELECT [KEY] AS id, RANK AS rank FROM CONTAINSTABLE(docs_passages, text, N'"rotate" AND "key"')`,
        );
      assert.deepEqual(ids(results).toSorted(), ['K', 'b', 'k']);
      assert.deepEqual(
        results.map(({ passage, score }) => [passage.id, score]),
        ids(results).map((id) => [
          id,
          engine.find((row) => row.id === id)?.rank,
        ]),
      );
      assert.ok(
        results.every(
          ({ score }, i) =>
            i === 0 || (score ?? 0) <= (results[i - 1]?.score ?? 0),
        ),
      );
      assert.deepEqual(ids(results), ['b', 'K', 'k']);
      assert.ok((results[0]?.score ?? 0) > (results[1]?.score ?? 0));
      assert.ok(results.every(({ score }) => (score ?? 0) > 0));
      assert.deepEqual(
        results.find(({ passage }) => passage.id === 'K')?.passage,
        {
          id: 'K',
          text: 'rotate the signing key',
          source: 'doc-K',
          seq: 0,
          start: 0,
          end: 22,
          metadata: { product: null },
        },
      );
    },
  );

  test(
    'when the id of the passages is case-insensitive, a match of the index is the passage of its own id, not one that differs only in case, and a tie goes to the smaller id in binary order',
    { skip: emulation },
    async (t) => {
      // Arrange: the passages keep the case-insensitive collation of the server
      // in their id, so they have no key: a key in that collation refuses `a`
      // beside `A` (error 2627). The table of the index has the binary key that
      // a full-text index needs. `B` sorts after `a` in the collation of the
      // passages.
      await using database = await server().database();
      const pool = await database.pool();
      await pool.request().batch(`
    CREATE TABLE docs_passages (id NVARCHAR(450) NOT NULL, source NVARCHAR(400) NOT NULL, seq INT NOT NULL, start INT NOT NULL, [end] INT NOT NULL, text NVARCHAR(MAX) NOT NULL);
    CREATE TABLE docs_index (id NVARCHAR(450) COLLATE Latin1_General_100_BIN2 NOT NULL CONSTRAINT pk_docs_index PRIMARY KEY, text NVARCHAR(MAX) NOT NULL);
    INSERT INTO docs_passages VALUES (N'a', N'doc-a', 0, 0, 14, N'rotate the key'), (N'A', N'doc-A', 0, 0, 12, N'nothing here'), (N'B', N'doc-B', 0, 0, 14, N'rotate the key');
    INSERT INTO docs_index SELECT id, text FROM docs_passages;
  `);
      await fullTextIndex(pool, 'docs_index', 'pk_docs_index', t.signal);
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_index' },
      });

      // Act
      const results = (await retriever.retrieve('key')).passages;
      const cut = (await retriever.retrieve('key', { topK: 1 })).passages;

      // Assert
      assert.deepEqual(
        results.map(({ passage }) => [passage.id, passage.text]),
        [
          ['B', 'rotate the key'],
          ['a', 'rotate the key'],
        ],
      );
      assert.equal(results[0]?.score, results[1]?.score);
      assert.deepEqual(ids(cut), ['B']);
    },
  );

  test(
    'the words of the query join with AND under matching { predicate: CONTAINS, operator: AND }, and with OR under operator OR',
    { skip: emulation },
    async (t) => {
      // Arrange
      await using database = await server().database();
      const pool = await database.pool();
      await contract(
        pool,
        [
          { id: 'both', text: 'rotate the signing key' },
          { id: 'rotate', text: 'rotate logs daily' },
          { id: 'signing', text: 'signing certificates' },
          { id: 'neither', text: 'nothing here' },
        ],
        t.signal,
      );
      const options = {
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
      };

      // Act
      const and = (
        await new SqlServerKeywordRetriever({
          ...options,
          matching: { predicate: 'CONTAINS', operator: 'AND' },
        }).retrieve('rotate signing')
      ).passages;
      const or = (
        await new SqlServerKeywordRetriever({
          ...options,
          matching: { predicate: 'CONTAINS', operator: 'OR' },
        }).retrieve('rotate signing')
      ).passages;

      // Assert
      assert.deepEqual(ids(and), ['both']);
      assert.deepEqual(ids(or).toSorted(), ['both', 'rotate', 'signing']);
      assert.equal(ids(or)[0], 'both');
    },
  );

  test(
    'keywords are matched in place of the words of query, and the words of query when the bundle has no keywords, as when the query is a string',
    { skip: emulation },
    async (t) => {
      // Arrange
      await using database = await server().database();
      const pool = await database.pool();
      await contract(
        pool,
        [
          { id: 'both', text: 'rotate the signing key' },
          { id: 'renew', text: 'renew the certificate' },
        ],
        t.signal,
      );
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
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

      // Assert: 'signing key' is one CONTAINS phrase, which 'both' holds.
      assert.deepEqual(ids(byKeywords), ['both']);
      assert.deepEqual(ids(byQuery), ['renew']);
      assert.deepEqual(byString, byQuery);
    },
  );

  test(
    'under CONTAINS each keyword is one phrase, so its words match side by side and in order, under AND and under OR, while each word of a text matches anywhere',
    { skip: emulation },
    async (t) => {
      // Arrange: 'reversed' and 'apart' hold every word of the keywords, but
      // not side by side in their order.
      await using database = await server().database();
      const pool = await database.pool();
      await contract(
        pool,
        [
          { id: 'hf', text: 'chronic heart failure in adults' },
          { id: 'reversed', text: 'failure of the heart muscle' },
          { id: 'ace', text: 'an ACE inhibitor lowers pressure' },
          { id: 'both', text: 'heart failure treated with an ACE inhibitor' },
          { id: 'apart', text: 'failure of the heart and an inhibitor of ACE' },
        ],
        t.signal,
      );
      const options = {
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
      };
      const and = new SqlServerKeywordRetriever({
        ...options,
        matching: { predicate: 'CONTAINS', operator: 'AND' },
      });
      const or = new SqlServerKeywordRetriever({
        ...options,
        matching: { predicate: 'CONTAINS', operator: 'OR' },
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
          Object.entries(results).map(([name, found]) => [
            name,
            found.toSorted(),
          ]),
        ),
        {
          one: ['both', 'hf'],
          and: ['both'],
          or: ['ace', 'both', 'hf'],
          text: ['apart', 'both', 'hf', 'reversed'],
        },
      );
    },
  );

  test(
    'a keyword with CONTAINS syntax in it is one phrase of text: its OR, NEAR and quotes are part of the phrase and never run as operators',
    { skip: emulation },
    async (t) => {
      // Arrange
      await using database = await server().database();
      const pool = await database.pool();
      await contract(
        pool,
        [
          { id: 'or', text: 'heart or failure' },
          { id: 'reversed', text: 'failure or heart' },
          { id: 'near', text: 'heart near failure' },
          { id: 'hf', text: 'heart failure' },
        ],
        t.signal,
      );
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
      });
      const byKeyword = async (keyword: string) =>
        ids(
          (await retriever.retrieve({ query: 'q', keywords: [keyword] }))
            .passages,
        ).toSorted();

      // Act
      const results = {
        // As CONTAINS, OR would join heart and failure: every passage.
        or: await byKeyword('heart OR failure'),
        // As CONTAINS, NEAR would match heart close to failure.
        near: await byKeyword('heart NEAR failure'),
        // A `"` becomes a space, so it does not end the phrase.
        quotes: await byKeyword('heart" OR "failure'),
      };

      // Assert
      assert.deepEqual(results, {
        or: ['or'],
        near: ['near'],
        quotes: ['or'],
      });
    },
  );

  test(
    'under CONTAINS the stoplist of the index decides a stop word: without one it matches, and with the system stoplist an AND with a stop word gives no passages while an OR still matches',
    { skip: emulation },
    async (t) => {
      // Arrange: the same passages under an index without a stoplist and under
      // one with the system stoplist, in two schemas of one database.
      await using database = await server().database();
      const pool = await database.pool();
      const rows = [
        { id: 'the', text: 'the black cat' },
        { id: 'dog', text: 'a dog' },
      ];
      await contract(pool, rows, t.signal);
      await pool.request().batch('CREATE SCHEMA stop');
      await contract(pool, rows, t.signal, {
        schema: 'stop',
        stoplist: 'SYSTEM',
      });
      const retriever = (schema: string, operator: 'AND' | 'OR' = 'AND') =>
        new SqlServerKeywordRetriever({
          store: new SqlServerPassageStore({
            session: session(pool),
            schema,
            passages: 'docs_passages',
            metadata: (columns) => columns,
          }),
          index: { table: 'docs_passages' },
          matching: { predicate: 'CONTAINS', operator },
        });

      // Act
      const results = {
        off: ids((await retriever('dbo').retrieve('the cat')).passages),
        offStopWordOnly: ids((await retriever('dbo').retrieve('the')).passages),
        system: ids((await retriever('stop').retrieve('the cat')).passages),
        systemOr: ids(
          (await retriever('stop', 'OR').retrieve('the cat')).passages,
        ),
        systemWord: ids((await retriever('stop').retrieve('cat')).passages),
      };

      // Assert
      assert.deepEqual(results, {
        off: ['the'],
        offStopWordOnly: ['the'],
        system: [],
        systemOr: ['the'],
        systemWord: ['the'],
      });
    },
  );

  test(
    'under CONTAINS each word of the query is one phrase, so CONTAINS syntax in it matches as text and never runs as an operator',
    { skip: emulation },
    async (t) => {
      // Arrange
      await using database = await server().database();
      const pool = await database.pool();
      await contract(
        pool,
        [
          { id: 'hyphen', text: 'the key-rotation runbook' },
          { id: 'vault', text: 'vault keeps secrets' },
          { id: 'consul', text: 'consul keeps services' },
          { id: 'keystone', text: 'keystone service' },
          { id: 'words', text: 'near and or' },
        ],
        t.signal,
      );
      // In a second schema, the passages that the words match as text.
      await pool.request().batch('CREATE SCHEMA phrases');
      await contract(
        pool,
        [
          { id: 'pipe', text: 'vault|consul' },
          { id: 'ampersand', text: 'consul&!vault' },
          { id: 'near', text: 'keeps near secrets' },
          { id: 'keyst', text: 'the keyst file' },
          { id: 'split', text: 'va ult' },
        ],
        t.signal,
        { schema: 'phrases' },
      );
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
        matching: { predicate: 'CONTAINS', operator: 'AND' },
      });
      const asText = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(pool),
          schema: 'phrases',
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
        matching: { predicate: 'CONTAINS', operator: 'AND' },
      });

      // Act
      const matches = {
        or: ids((await asText.retrieve('vault|consul')).passages),
        andNot: ids((await asText.retrieve('consul&!vault')).passages),
        near: ids((await asText.retrieve('keeps NEAR secrets')).passages),
        // `*` becomes a space, so the word is keyst and not a prefix.
        prefix: ids((await asText.retrieve('keyst*')).passages),
        // `"` becomes a space inside the word and does not end its phrase.
        innerQuote: ids((await asText.retrieve('va"ult')).passages),
      };
      const results = {
        hyphen: ids((await retriever.retrieve('key-rotation')).passages),
        // As CONTAINS, `vault|consul` is vault or consul.
        or: ids((await retriever.retrieve('vault|consul')).passages),
        // As CONTAINS, `&` joins and `!` negates: consul and not vault.
        andNot: ids((await retriever.retrieve('consul&!vault')).passages),
        // As CONTAINS, `NEAR` is an operator: keeps near secrets.
        near: ids((await retriever.retrieve('keeps NEAR secrets')).passages),
        // A word that is an operator of CONTAINS is a word.
        operatorWord: ids((await retriever.retrieve('AND')).passages),
        // As CONTAINS, `"keyst*"` is every word that starts with keyst.
        prefix: ids((await retriever.retrieve('keyst*')).passages),
        // As CONTAINS, an open quote or parenthesis is a syntax error.
        quote: ids((await retriever.retrieve('vault"')).passages),
        innerQuote: ids((await retriever.retrieve('va"ult')).passages),
        parenthesis: ids((await retriever.retrieve('(vault')).passages),
      };

      // Assert
      assert.deepEqual(results, {
        hyphen: ['hyphen'],
        or: [],
        andNot: [],
        near: [],
        operatorWord: ['words'],
        prefix: [],
        quote: ['vault'],
        innerQuote: [],
        parenthesis: ['vault'],
      });
      assert.deepEqual(matches, {
        or: ['pipe'],
        andNot: ['ampersand'],
        near: ['near'],
        prefix: ['keyst'],
        innerQuote: ['split'],
      });
    },
  );

  test(
    'a word of punctuation only is dropped, so it does not stop an AND from matching, and a query of no words gives no passages, by default and under CONTAINS',
    { skip: emulation },
    async (t) => {
      // Arrange: SQL Server reads a phrase of punctuation only as a noise word,
      // which gives an AND no rows, and refuses an empty or blank condition of
      // CONTAINSTABLE and of FREETEXTTABLE (error 7645).
      await using database = await server().database();
      const pool = await database.pool();
      await contract(pool, [{ id: 'a', text: 'rotate the key' }], t.signal);
      const options = {
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
      };
      const results = async (retriever: SqlServerKeywordRetriever) => ({
        punctuation: ids(
          (await retriever.retrieve('rotate & | ! ~ ( key')).passages,
        ),
        punctuationOnly: ids((await retriever.retrieve('& | "*"')).passages),
        whitespace: ids((await retriever.retrieve(' \t\n ')).passages),
        keywords: ids(
          (await retriever.retrieve({ query: 'q', keywords: ['&', 'key'] }))
            .passages,
        ),
        punctuationKeywords: ids(
          (await retriever.retrieve({ query: 'q', keywords: ['&', '"*"'] }))
            .passages,
        ),
      });

      // Act
      const byDefault = await results(new SqlServerKeywordRetriever(options));
      const contains = await results(
        new SqlServerKeywordRetriever({
          ...options,
          matching: { predicate: 'CONTAINS', operator: 'AND' },
        }),
      );

      // Assert
      const expected = {
        punctuation: ['a'],
        punctuationOnly: [],
        whitespace: [],
        keywords: ['a'],
        punctuationKeywords: [],
      };
      assert.deepEqual(
        { byDefault, contains },
        { byDefault: expected, contains: expected },
      );
    },
  );

  test(
    'a condition over 4,000 characters reaches the caller as the error 4110 of SQL Server, by default and under CONTAINS',
    { skip: emulation },
    async (t) => {
      // Arrange: the driver binds a text over 4,000 characters as NVARCHAR(MAX),
      // which CONTAINSTABLE and FREETEXTTABLE refuse.
      await using database = await server().database();
      const pool = await database.pool();
      await contract(pool, [{ id: 'a', text: 'rotate the key' }], t.signal);
      const options = {
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
      };
      const text = Array(600).fill('rotate').join(' ');

      // Act
      const byDefault = new SqlServerKeywordRetriever(options).retrieve(text);
      const contains = new SqlServerKeywordRetriever({
        ...options,
        matching: { predicate: 'CONTAINS', operator: 'AND' },
      }).retrieve(text);

      // Assert
      await assert.rejects(byDefault, { number: 4110 });
      await assert.rejects(contains, { number: 4110 });
    },
  );

  test(
    'a keyword search gives 10 passages when the call gives no topK, topK when it gives one, and only the passages its filter selects',
    { skip: emulation },
    async (t) => {
      // Arrange
      await using database = await server().database();
      const pool = await database.pool();
      await contract(
        pool,
        Array.from({ length: 12 }, (_, i) => ({
          id: `p${String(i).padStart(2, '0')}`,
          text: 'rotate the key',
          product: i % 2 === 0 ? 'vault' : 'consul',
        })),
        t.signal,
      );
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
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
    },
  );

  test(
    'an aborted keyword search rejects with the reason of its signal',
    { skip: emulation },
    async (t) => {
      // Arrange
      await using database = await server().database();
      const pool = await database.pool();
      await contract(pool, [{ id: 'a', text: 'rotate the key' }], t.signal);
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
      });
      const reason = new Error('cancelled');

      // Act
      const result = retriever.retrieve('key', {
        signal: AbortSignal.abort(reason),
      });

      // Assert
      await assert.rejects(result, (error) => error === reason);
    },
  );

  test(
    'passages that are a view over the table that holds the index are searched through the view, by names that need quoting',
    { skip: emulation },
    async (t) => {
      // Arrange: elt gives the passages with the metadata of their source row
      // through a view, and the table of the index holds the text. The table
      // name `docs ]parts]` has the closing bracket of a T-SQL identifier.
      await using database = await server().database();
      const pool = await database.pool();
      await pool.request().batch(`
    CREATE TABLE [docs ]]parts]]] (id NVARCHAR(450) COLLATE Latin1_General_100_BIN2 NOT NULL CONSTRAINT pk_docs_parts PRIMARY KEY, source NVARCHAR(400) NOT NULL, seq INT NOT NULL, start INT NOT NULL, [end] INT NOT NULL, text NVARCHAR(MAX) NOT NULL);
    CREATE TABLE docs_sources (source NVARCHAR(400) NOT NULL PRIMARY KEY, product NVARCHAR(100) NOT NULL);
    INSERT INTO docs_sources VALUES (N'doc-a', N'gcc'), (N'doc-b', N'git');
    INSERT INTO [docs ]]parts]]] VALUES (N'a', N'doc-a', 0, 0, 14, N'compile C code'), (N'b', N'doc-b', 0, 0, 21, N'fix a broken git repo'), (N'c', N'doc-a', 1, 0, 9, N'git blame');
  `);
      await pool
        .request()
        .batch(
          'CREATE VIEW [docs passages] AS SELECT p.*, s.product FROM [docs ]]parts]]] p JOIN docs_sources s ON s.source = p.source',
        );
      await fullTextIndex(pool, '[docs ]]parts]]]', 'pk_docs_parts', t.signal);
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs ]parts]' },
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
    },
  );

  test(
    'a store with a schema searches the full-text index of the table of that schema, and a store without one finds it through the default schema of the user',
    { skip: emulation },
    async (t) => {
      // Arrange: the same contract in dbo, the default schema of the user, and
      // in a second schema, each with passages and a full-text index of its own.
      await using database = await server().database();
      const pool = await database.pool();
      await contract(pool, [{ id: 'dbo-a', text: 'rotate the key' }], t.signal);
      // CREATE SCHEMA is the only statement of its batch.
      await pool.request().batch('CREATE SCHEMA rag');
      await contract(
        pool,
        [{ id: 'rag-a', text: 'rotate the key' }],
        t.signal,
        {
          schema: 'rag',
        },
      );
      const retriever = (store: SqlServerPassageStore) =>
        new SqlServerKeywordRetriever({
          store,
          index: { table: 'docs_passages' },
        });

      // Act
      const fromSchema = (
        await retriever(
          new SqlServerPassageStore({
            session: session(pool),
            schema: 'rag',
            passages: 'docs_passages',
            metadata: (columns) => columns,
          }),
        ).retrieve('key')
      ).passages;
      const fromDefault = (
        await retriever(
          new SqlServerPassageStore({
            session: session(pool),
            passages: 'docs_passages',
            metadata: (columns) => columns,
          }),
        ).retrieve('key')
      ).passages;

      // Assert
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
      assert.deepEqual(ids(fromDefault), ['dbo-a']);
    },
  );

  test(
    'two stores on two databases, alive at once, each search the full-text index of their own session',
    { skip: emulation },
    async (t) => {
      // Arrange: both stores exist before either retriever, and their rows differ.
      await using first = await server().database();
      await using second = await server().database();
      const firstPool = await first.pool();
      const secondPool = await second.pool();
      await contract(
        firstPool,
        [{ id: 'first-a', text: 'rotate the key' }],
        t.signal,
      );
      await contract(
        secondPool,
        [{ id: 'second-a', text: 'rotate the key' }],
        t.signal,
      );
      const fromFirst = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(firstPool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
      });
      const fromSecond = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(secondPool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
      });

      // Act
      const firstResults = (await fromFirst.retrieve('key')).passages;
      const secondResults = (await fromSecond.retrieve('key')).passages;

      // Assert
      assert.deepEqual(ids(firstResults), ['first-a']);
      assert.deepEqual(ids(secondResults), ['second-a']);
    },
  );

  test(
    'the metadata of each passage is what the metadata of its store reads from the other columns of its row, through retrieve and a filter on it',
    { skip: emulation },
    async (t) => {
      // Arrange
      await using database = await server().database();
      const pool = await database.pool();
      await contract(
        pool,
        [
          { id: 'k', text: 'rotate the key', product: 'kms' },
          { id: 'v', text: 'rotate the vault key', product: 'vault' },
        ],
        t.signal,
      );
      const metadata = new RecordingMetadata(({ product }) => {
        if (product !== 'kms' && product !== 'vault') {
          throw new TypeError(
            `A passage is of kms or vault, not ${String(product)}`,
          );
        }
        return { product };
      });
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: metadata.read,
        }),
        index: { table: 'docs_passages' },
      });

      // Act
      const all = (await retriever.retrieve('rotate key')).passages;
      const vault = (
        await retriever.retrieve('rotate key', {
          filter: { field: 'metadata.product', operator: '!=', value: 'kms' },
        })
      ).passages;

      // Assert
      const passages = [...all, ...vault].map(({ passage }) => passage);
      assert.deepEqual(
        passages
          .map(({ id, metadata }) => [id, metadata])
          .toSorted(([a], [b]) => String(a).localeCompare(String(b))),
        [
          ['k', { product: 'kms' }],
          ['v', { product: 'vault' }],
          ['v', { product: 'vault' }],
        ],
      );
      assert.ok(passages.every((passage) => metadata.gave(passage.metadata)));
      assert.deepEqual(
        metadata.columns.toSorted((a, b) =>
          String(a['product']).localeCompare(String(b['product'])),
        )[0],
        { product: 'kms' },
      );
    },
  );

  test(
    "the keyword search passes the call's signal to the session",
    { skip: emulation },
    async (t) => {
      // Arrange: the session records the signal of each query.
      await using database = await server().database();
      const pool = await database.pool();
      await contract(pool, [{ id: 'a', text: 'rotate the key' }], t.signal);
      const signals: (AbortSignal | undefined)[] = [];
      const host = session(pool);
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: {
            query: (sql, parameters, options) => {
              signals.push(options?.signal);
              return host.query(sql, parameters);
            },
          },
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
      });
      const controller = new AbortController();
      const { signal } = controller;

      // Act
      const result = await retriever.retrieve('key', { signal });

      // Assert
      assert.deepEqual(ids(result.passages), ['a']);
      assert.deepEqual(signals, [signal]);
    },
  );

  test('a matching predicate other than FREETEXT or CONTAINS, or a CONTAINS operator other than AND or OR, is refused with a RangeError when the retriever is made', () => {
    // Arrange
    const store = new SqlServerPassageStore({
      session: { query: () => Promise.reject(new Error('no query runs')) },
      passages: 'docs_passages',
      metadata: (columns) => columns,
    });

    // Act
    const predicate = () =>
      new SqlServerKeywordRetriever({
        store,
        index: { table: 'docs_passages' },
        // @ts-expect-error: a JavaScript caller can pass any predicate
        matching: { predicate: 'CONTAINSTABLE', operator: 'AND' },
      });
    const operator = () =>
      new SqlServerKeywordRetriever({
        store,
        index: { table: 'docs_passages' },
        // @ts-expect-error: a JavaScript caller can pass any operator
        matching: { predicate: 'CONTAINS', operator: 'XOR' },
      });

    // Assert
    assert.throws(
      predicate,
      new RangeError(
        "The predicate of matching is 'FREETEXT' or 'CONTAINS', not CONTAINSTABLE",
      ),
    );
    assert.throws(
      operator,
      new RangeError("The operator of matching is 'AND' or 'OR', not XOR"),
    );
  });

  test('the CONTAINS condition that the session receives joins the phrases with AND under matching { predicate: CONTAINS, operator: AND }, and with OR under operator OR', async () => {
    // Arrange: the session records the parameters of each query and gives no row.
    const conditions: unknown[] = [];
    const store = new SqlServerPassageStore({
      session: {
        query: async (_sql, parameters) => {
          conditions.push(
            ...Object.values(parameters).filter(
              (value) => typeof value === 'string' && value.includes('rotate'),
            ),
          );
          return [];
        },
      },
      passages: 'docs_passages',
      metadata: (columns) => columns,
    });
    const index = { table: 'docs_passages' };

    // Act
    await new SqlServerKeywordRetriever({
      store,
      index,
      matching: { predicate: 'CONTAINS', operator: 'AND' },
    }).retrieve('rotate signing');
    await new SqlServerKeywordRetriever({
      store,
      index,
      matching: { predicate: 'CONTAINS', operator: 'OR' },
    }).retrieve('rotate signing');

    // Assert
    assert.deepEqual(conditions, [
      '"rotate" AND "signing"',
      '"rotate" OR "signing"',
    ]);
  });

  test('under CONTAINS the condition that the session receives has each keyword as one phrase, joined by the operator, and each word of a text as its own phrase', async () => {
    // Arrange: the session records the parameters of each query and gives no row.
    const conditions: unknown[] = [];
    const store = new SqlServerPassageStore({
      session: {
        query: async (_sql, parameters) => {
          conditions.push(
            ...Object.values(parameters).filter(
              (value) => typeof value === 'string' && value.includes('heart'),
            ),
          );
          return [];
        },
      },
      passages: 'docs_passages',
      metadata: (columns) => columns,
    });
    const index = { table: 'docs_passages' };
    const and = new SqlServerKeywordRetriever({
      store,
      index,
      matching: { predicate: 'CONTAINS', operator: 'AND' },
    });
    const or = new SqlServerKeywordRetriever({
      store,
      index,
      matching: { predicate: 'CONTAINS', operator: 'OR' },
    });
    const keywords = ['heart failure', 'ACE inhibitor'] as const;

    // Act
    await and.retrieve({ query: 'q', keywords });
    await or.retrieve({ query: 'q', keywords });
    await and.retrieve({ query: 'q', keywords: ['heart" OR "failure*'] });
    await and.retrieve('heart failure');

    // Assert
    assert.deepEqual(conditions, [
      '"heart failure" AND "ACE inhibitor"',
      '"heart failure" OR "ACE inhibitor"',
      '"heart  OR  failure"',
      '"heart" AND "failure"',
    ]);
  });

  test('by default the session receives a text whole as the condition of FREETEXTTABLE, each keyword as a FORMSOF(INFLECTIONAL) phrase of an ISABOUT in CONTAINSTABLE, with top_n_by_rank equal to topK only when the call has no filter and only in the branch the engine runs when OBJECT_ID of the passages is OBJECT_ID of the index table, and a query of no words sends no statement', async () => {
    // Arrange: the session records the table functions of each statement with
    // the values of their arguments and the branch each runs in: when OBJECT_ID
    // of the passages is OBJECT_ID of the index table, when it is not, or
    // always. It records the names that the guard compares, and gives no row.
    // The passages are a view, so the two names differ.
    const calls: { functions: unknown[][]; same: unknown[] }[] = [];
    const store = new SqlServerPassageStore({
      session: {
        query: async (sql, parameters) => {
          const value = (argument: string) => parameters[argument.slice(1)];
          const [, passages = '', table = ''] =
            /OBJECT_ID\((@\w+)\) = OBJECT_ID\((@\w+)\)/.exec(sql) ?? [];
          calls.push({
            functions: [
              ...sql.matchAll(
                /(FREETEXTTABLE|CONTAINSTABLE)\((.*?)\)(?: WHERE IIF\(.*?, 1, 0\) = ([01]))?/gs,
              ),
            ].map(([, from, list = '', branch]) => [
              from,
              ...list.split(', ').slice(2).map(value),
              { '1': 'same', '0': 'other' }[branch ?? ''] ?? 'always',
            ]),
            same: passages === '' ? [] : [value(passages), value(table)],
          });
          return [];
        },
      },
      passages: 'docs_view',
      metadata: (columns) => columns,
    });
    const retriever = new SqlServerKeywordRetriever({
      store,
      index: { table: 'docs_passages' },
    });
    const filter = {
      field: 'metadata.product',
      operator: '==',
      value: 'vault',
    } as const;

    // Act
    const results = [
      await retriever.retrieve('is lisinopril "safe" OR (in) pregnancy*?'),
      await retriever.retrieve('key', { topK: 3 }),
      await retriever.retrieve('key', { filter }),
      await retriever.retrieve({
        query: 'q',
        keywords: ['heart failure', 'ACE inhibitor'],
      }),
      await retriever.retrieve(
        { query: 'q', keywords: ['heart" OR "failure*', '&'] },
        { filter },
      ),
      await retriever.retrieve(' \t\n '),
      await retriever.retrieve({ query: 'q', keywords: ['&', '"*"'] }),
    ];

    // Assert
    const guard = ['[docs_view]', '[docs_passages]'];
    const isabout =
      'ISABOUT(FORMSOF(INFLECTIONAL, "heart failure"), FORMSOF(INFLECTIONAL, "ACE inhibitor"))';
    const question = 'is lisinopril "safe" OR (in) pregnancy*?';
    assert.deepEqual(calls, [
      {
        functions: [
          ['FREETEXTTABLE', question, 10, 'same'],
          ['FREETEXTTABLE', question, 'other'],
        ],
        same: guard,
      },
      {
        functions: [
          ['FREETEXTTABLE', 'key', 3, 'same'],
          ['FREETEXTTABLE', 'key', 'other'],
        ],
        same: guard,
      },
      { functions: [['FREETEXTTABLE', 'key', 'always']], same: [] },
      {
        functions: [
          ['CONTAINSTABLE', isabout, 10, 'same'],
          ['CONTAINSTABLE', isabout, 'other'],
        ],
        same: guard,
      },
      {
        functions: [
          [
            'CONTAINSTABLE',
            'ISABOUT(FORMSOF(INFLECTIONAL, "heart  OR  failure"))',
            'always',
          ],
        ],
        same: [],
      },
    ]);
    assert.deepEqual(
      results.map(({ passages }) => passages),
      Array(7).fill([]),
    );
  });

  test(
    'by default a question finds a passage by an inflection of its word, through FREETEXTTABLE, whose RANK is the score, while CONTAINS AND finds none',
    { skip: emulation },
    async (t) => {
      // Arrange
      await using database = await server().database();
      const pool = await database.pool();
      await contract(
        pool,
        [
          { id: 'ran', text: 'he ran a mile' },
          { id: 'runs', text: 'she runs every morning' },
          { id: 'mice', text: 'the mice escaped' },
          { id: 'none', text: 'nothing here at all' },
        ],
        t.signal,
      );
      const options = {
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
      };
      const retriever = new SqlServerKeywordRetriever(options);

      // Act
      const running = (await retriever.retrieve('running')).passages;
      const mouse = (await retriever.retrieve('mouse')).passages;
      const contains = (
        await new SqlServerKeywordRetriever({
          ...options,
          matching: { predicate: 'CONTAINS', operator: 'AND' },
        }).retrieve('running')
      ).passages;

      // Assert
      // The value of SQL Server's own ranking for the same text.
      const { recordset: engine } = await pool
        .request()
        .query(
          `SELECT [KEY] AS id, RANK AS rank FROM FREETEXTTABLE(docs_passages, text, N'running')`,
        );
      assert.deepEqual(ids(running).toSorted(), ['ran', 'runs']);
      assert.deepEqual(
        running.map(({ passage, score }) => [passage.id, score]),
        ids(running).map((id) => [
          id,
          engine.find((row) => row.id === id)?.rank,
        ]),
      );
      assert.ok(
        running.every(
          ({ score }) => Number.isFinite(score) && (score ?? 0) > 0,
        ),
      );
      assert.deepEqual(ids(mouse), ['mice']);
      assert.deepEqual(ids(contains), []);
    },
  );

  test(
    'by default CONTAINS syntax in a text is text: OR and NEAR are words, and an open quote, parenthesis or prefix star is no error',
    { skip: emulation },
    async (t) => {
      // Arrange
      await using database = await server().database();
      const pool = await database.pool();
      await contract(
        pool,
        [
          { id: 'or', text: 'heart or failure' },
          { id: 'near', text: 'heart near failure' },
          { id: 'hf', text: 'chronic heart failure' },
          { id: 'none', text: 'nothing here at all' },
        ],
        t.signal,
      );
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
      });

      // Act
      const or = (await retriever.retrieve('heart OR failure')).passages;
      const near = (await retriever.retrieve('heart NEAR failure')).passages;
      const open = (await retriever.retrieve('"heart NEAR (fail*')).passages;

      // Assert: the passage that holds the word or (near) ranks first.
      assert.deepEqual(
        { or: ids(or).toSorted(), near: ids(near).toSorted() },
        { or: ['hf', 'near', 'or'], near: ['hf', 'near', 'or'] },
      );
      assert.equal(ids(or)[0], 'or');
      assert.equal(ids(near)[0], 'near');
      assert.ok(ids(open).includes('near'));
    },
  );

  test(
    'by default each keyword is one phrase with its inflections, a passage that holds any keyword matches, and words of a keyword apart or out of order do not',
    { skip: emulation },
    async (t) => {
      // Arrange
      await using database = await server().database();
      const pool = await database.pool();
      await contract(
        pool,
        [
          { id: 'hf', text: 'chronic heart failure in adults' },
          { id: 'reversed', text: 'failure of the heart muscle' },
          { id: 'ace', text: 'an ACE inhibitor lowers pressure' },
          { id: 'apart', text: 'an inhibitor of ACE' },
        ],
        t.signal,
      );
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
      });

      // Act
      const results = (
        await retriever.retrieve({
          query: 'q',
          keywords: ['heart failures', 'ACE inhibitors'],
        })
      ).passages;

      // Assert
      assert.deepEqual(ids(results).toSorted(), ['ace', 'hf']);
      assert.ok(
        results.every(
          ({ score }) => Number.isFinite(score) && (score ?? 0) > 0,
        ),
      );
    },
  );

  test(
    'by default a call with a filter still gives topK passages that pass it when the passages that rank higher fail it',
    { skip: emulation },
    async (t) => {
      // Arrange: the vault passages hold key twice and rank above the consul
      // ones, so a cut to the two best matches before the filter keeps none.
      await using database = await server().database();
      const pool = await database.pool();
      await contract(
        pool,
        Array.from({ length: 8 }, (_, i) => ({
          id: `p${i}`,
          text: i % 2 === 0 ? 'rotate the key, the key' : 'rotate the key',
          product: i % 2 === 0 ? 'vault' : 'consul',
        })),
        t.signal,
      );
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
      });
      const filter = {
        field: 'metadata.product',
        operator: '==',
        value: 'consul',
      } as const;

      // Act
      const text = (await retriever.retrieve('key', { topK: 2, filter }))
        .passages;
      const keywords = (
        await retriever.retrieve(
          { query: 'q', keywords: ['key'] },
          { topK: 2, filter },
        )
      ).passages;
      const best = (await retriever.retrieve('key', { topK: 2 })).passages;

      // Assert
      assert.deepEqual(ids(best), ['p0', 'p2']);
      assert.deepEqual(ids(text), ['p1', 'p3']);
      assert.deepEqual(ids(keywords), ['p1', 'p3']);
    },
  );

  test(
    'by default a call with no filter still gives topK passages when the passages are a view that hides the passages that rank higher',
    { skip: emulation },
    async (t) => {
      // Arrange: the vault passages hold key twice and rank above the consul
      // ones, and the view of the passages shows only consul, so a cut to the
      // two best matches of the table before the join keeps none.
      await using database = await server().database();
      const pool = await database.pool();
      await contract(
        pool,
        Array.from({ length: 8 }, (_, i) => ({
          id: `p${i}`,
          text: i % 2 === 0 ? 'rotate the key, the key' : 'rotate the key',
          product: i % 2 === 0 ? 'vault' : 'consul',
        })),
        t.signal,
      );
      await pool
        .request()
        .batch(
          "CREATE VIEW docs_consul AS SELECT * FROM docs_passages WHERE product = N'consul'",
        );
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_consul',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
      });

      // Act
      const text = (await retriever.retrieve('key', { topK: 2 })).passages;
      const keywords = (
        await retriever.retrieve({ query: 'q', keywords: ['key'] }, { topK: 2 })
      ).passages;

      // Assert
      assert.deepEqual(ids(text), ['p1', 'p3']);
      assert.deepEqual(ids(keywords), ['p1', 'p3']);
    },
  );

  test(
    'by default a call with no filter gives topK passages with the best scores that FREETEXTTABLE and the ISABOUT of CONTAINSTABLE give with no cut, each a match with its uncut score, best first and a tie in binary order of the id',
    { skip: emulation },
    async (t) => {
      // Arrange: the full-text index exists on the empty table, and change
      // tracking indexes each row as it comes, in reverse binary order of the
      // id, so the smallest id is the last the index sees. Several tie. A full
      // population of a filled table would see the rows in the order of the
      // clustered key, the binary id, whatever order they came in.
      await using database = await server().database();
      const pool = await database.pool();
      await contract(pool, [], t.signal);
      await insert(
        pool,
        '[dbo].docs_passages',
        [
          ...Array.from({ length: 6 }, (_, i) => ({
            id: `p${i}`,
            text: 'rotate the key',
          })),
          { id: 'b', text: 'key key key rotation' },
          { id: 'a', text: 'rotate the key' },
          { id: 'A', text: 'rotate the key' },
          { id: 'B', text: 'rotate the signing key' },
        ].sort((x, y) => (x.id < y.id ? 1 : -1)),
      );
      await populated(pool, '[dbo].docs_passages', t.signal);
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
      });
      const uncut = async (from: string, condition: string) =>
        (
          await pool
            .request()
            .input('condition', condition)
            .query(
              `SELECT [KEY] AS id, RANK AS score FROM ${from}(docs_passages, text, @condition) ORDER BY RANK DESC, [KEY]`,
            )
        ).recordset.map(({ id, score }): [string, number] => [id, score]);
      const scored = (
        passages: readonly {
          readonly passage: { readonly id: string };
          readonly score?: number;
        }[],
      ) =>
        passages.map(({ passage, score }): [string, number | undefined] => [
          passage.id,
          score,
        ]);

      // Act
      const results = {
        three: scored((await retriever.retrieve('key', { topK: 3 })).passages),
        five: scored(
          (await retriever.retrieve('rotate key', { topK: 5 })).passages,
        ),
        keywords: scored(
          (
            await retriever.retrieve(
              { query: 'q', keywords: ['rotate', 'signing key'] },
              { topK: 4 },
            )
          ).passages,
        ),
      };

      // Assert: which tied passages survive the cut follows the engine, which
      // keeps none in binary order of the id when the index saw the smallest
      // id last (ADR 0018), so the test asserts the scores, not the ids.
      const matches = {
        three: await uncut('FREETEXTTABLE', 'key'),
        five: await uncut('FREETEXTTABLE', 'rotate key'),
        keywords: await uncut(
          'CONTAINSTABLE',
          'ISABOUT(FORMSOF(INFLECTIONAL, "rotate"), FORMSOF(INFLECTIONAL, "signing key"))',
        ),
      };
      const scores = (pairs: readonly (readonly [string, unknown])[]) =>
        pairs.map(([, score]) => score);
      assert.deepEqual(
        {
          three: scores(results.three),
          five: scores(results.five),
          keywords: scores(results.keywords),
        },
        {
          three: scores(matches.three.slice(0, 3)),
          five: scores(matches.five.slice(0, 5)),
          keywords: scores(matches.keywords.slice(0, 4)),
        },
      );
      // Each passage given that is a match with its uncut score, in the order
      // of best first and a tie in binary order of the id.
      const kept = (
        got: readonly [string, number | undefined][],
        all: readonly [string, number][],
      ) =>
        got
          .filter(([id, score]) =>
            all.some((match) => match[0] === id && match[1] === score),
          )
          .toSorted(
            ([a, x = 0], [b, y = 0]) => y - x || (a < b ? -1 : a > b ? 1 : 0),
          );
      assert.deepEqual(
        {
          three: kept(results.three, matches.three),
          five: kept(results.five, matches.five),
          keywords: kept(results.keywords, matches.keywords),
        },
        results,
      );
      assert.equal(results.three.length, 3);
    },
  );

  // No engine runs: the check comes before any statement, so these cases run
  // where the engine is emulated too.
  void test.each([-1, 2.5, Number.NaN, Number.POSITIVE_INFINITY], (topK) =>
    test(`a topK of ${topK} in the call is a RangeError before any statement reaches the session, as Elasticsearch refuses a bad size`, async () => {
      // Arrange: a session that records each statement.
      const statements: string[] = [];
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: {
            query: async (sql) => {
              statements.push(sql);
              return [];
            },
          },
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
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

  test(
    "a topK of 0 in the call gives no passages, as Elasticsearch's size 0, though FREETEXTTABLE's top_n_by_rank gets 0",
    { skip: emulation },
    async (t) => {
      // Arrange
      await using database = await server().database();
      const pool = await database.pool();
      await contract(
        pool,
        [{ id: 'k', text: 'rotate the signing key' }],
        t.signal,
      );
      const retriever = new SqlServerKeywordRetriever({
        store: new SqlServerPassageStore({
          session: session(pool),
          passages: 'docs_passages',
          metadata: (columns) => columns,
        }),
        index: { table: 'docs_passages' },
      });

      // Act
      const result = await retriever.retrieve('rotate key', { topK: 0 });

      // Assert
      assert.deepEqual(result.passages, []);
    },
  );
});
