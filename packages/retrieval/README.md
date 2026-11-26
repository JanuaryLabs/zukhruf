# @zukhruf/retrieval

This package is the query side of retrieval-augmented generation (RAG). A query goes in. A retrieval result comes out: the best passages, best first, and the failures. An engine retriever, a fusion and a reranker give each passage a score, which is higher for a better passage; a host's source of order only, such as a web search, gives ranked passages with no score ([ADR 0021](./docs/adr/0021-a-retriever-says-whether-it-gives-scores-a-ranked-passage-has-none-and-a-scored-passage-always-has-one.md)). The package never cuts a document or writes a vector: elt writes the passages, their vectors with the model identity, and a keyword index ([ADR 0001](./docs/adr/0001-the-package-is-the-query-side-of-rag-and-reads-a-passage-contract-that-elt-writes.md)). A reranker may embed the text of the candidates of a query when that query runs, as a search embeds the query ([ADR 0022](./docs/adr/0022-a-reranker-may-embed-the-text-of-the-candidates-when-the-query-runs.md)).

The port of the package is `Retriever`. A query is a string, or a query bundle with a text for each kind of search ([ADR 0013](./docs/adr/0013-a-query-is-a-string-or-a-query-bundle-with-a-text-for-each-kind-of-search.md)). The engine retrievers read that passage contract with the SQL of SQLite, Postgres or SQL Server. A host can implement `Retriever` over any other source, such as a web search. Composite retrievers fuse retrievers, rerank or rewrite the query, and postprocessors cut, diversify, group, reorder and widen the result.

The package has four entry points. `@zukhruf/retrieval` has the port, the composite retrievers, the fusions and their strategies, the postprocessors and the errors. `@zukhruf/retrieval/sqlite`, `@zukhruf/retrieval/postgres` and `@zukhruf/retrieval/sqlserver` each have the passage store and the engine retrievers of one engine.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/retrieval @zukhruf/vectors ai zod
```

This program writes a small passage contract into an in-memory SQLite database and searches it by meaning. In production, elt writes the contract, and the model is an AI SDK embedding model. Here a stand-in model from `ai/test` counts three words, so the program runs offline.

```ts
import { DatabaseSync } from 'node:sqlite';

import { MockEmbeddingModelV4 } from 'ai/test';
import { z } from 'zod';

import {
  SqliteEmbeddingRetriever,
  SqlitePassageStore,
} from '@zukhruf/retrieval/sqlite';
import { Vector } from '@zukhruf/vectors';
import { install, toSql } from '@zukhruf/vectors/sqlite';

// A stand-in embedding model, so that the program runs offline: each vector
// counts three words. Give an AI SDK model in its place, such as
// openai.embedding('text-embedding-3-small').
const words = ['key', 'token', 'backup'];
const embedText = (text: string) =>
  words.map(
    (word) =>
      text
        .toLowerCase()
        .split(/\W+/)
        .filter((w) => w === word).length,
  );
const model = new MockEmbeddingModelV4({
  provider: 'toy',
  modelId: 'three-words',
  maxEmbeddingsPerCall: 100,
  doEmbed: async ({ values }) => ({
    embeddings: values.map(embedText),
    warnings: [],
  }),
});

// The passage contract. elt writes it; this program writes it by hand.
const database = new DatabaseSync(':memory:');
install(database); // registers vec_distance_cosine; or load sqlite-vec
database.exec(`
  CREATE TABLE docs_passages (id TEXT PRIMARY KEY, source TEXT NOT NULL, seq INTEGER NOT NULL, start INTEGER NOT NULL, "end" INTEGER NOT NULL, text TEXT NOT NULL, product TEXT, year INTEGER);
  CREATE TABLE docs_passage_vectors (id TEXT PRIMARY KEY, vector BLOB NOT NULL, model TEXT NOT NULL);
`);
const documents = [
  [
    'vault-guide',
    'vault',
    2025,
    [
      'Create a new key before you rotate the old key.',
      'Then move each token to the new key.',
      'Keep a backup of the old key for 30 days.',
    ],
  ],
  [
    'vault-faq',
    'vault',
    2024,
    [
      'A token expires after one hour.',
      'Revoke a token when a device is lost.',
    ],
  ],
  ['mail-guide', 'mail', 2025, ['Make a backup of each mailbox every night.']],
] as const;
const insertPassage = database.prepare(
  'INSERT INTO docs_passages VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
);
const insertVector = database.prepare(
  'INSERT INTO docs_passage_vectors VALUES (?, ?, ?)',
);
for (const [source, product, year, sentences] of documents) {
  let start = 0; // offsets count code points
  for (const [seq, sentence] of sentences.entries()) {
    // The passages tile their source: each keeps the space before it.
    const text = seq === 0 ? sentence : ` ${sentence}`;
    const id = `${source}#${seq}`;
    const end = start + [...text].length;
    insertPassage.run(id, source, seq, start, end, text, product, year);
    insertVector.run(
      id,
      toSql(Vector.from(embedText(text))),
      'toy/three-words (3 dimensions)',
    );
    start = end;
  }
}

// The metadata of a passage: the columns of its row beside the passage's own.
const Doc = z.object({ product: z.string(), year: z.number() });
const store = new SqlitePassageStore({
  database,
  passages: 'docs_passages',
  metadata: Doc.parse,
});
const retriever = new SqliteEmbeddingRetriever({
  store,
  vectors: 'docs_passage_vectors',
  model,
});

const { passages } = await retriever.retrieve('How do I rotate a key?', {
  topK: 3,
});
for (const { passage, score } of passages) {
  console.log(score.toFixed(3), passage.id, passage.text);
}
```

Output:

```
1.000 vault-guide#0 Create a new key before you rotate the old key.
0.707 vault-guide#1  Then move each token to the new key.
0.707 vault-guide#2  Keep a backup of the old key for 30 days.
```

The passages of one source tile it: each keeps its white space, two passages can overlap, and no passage starts after the end of the passages before it. `start` and `end` count code points, and `end` is exclusive ([ADR 0001](./docs/adr/0001-the-package-is-the-query-side-of-rag-and-reads-a-passage-contract-that-elt-writes.md), the amendment of 2026-11-24).

The passage store is the root of the composition. It holds the connection and the passages, and on Postgres and SQL Server the schema of the contract. Each retriever and `ContextWindow` takes the store and only its own part: the vectors and the model, or the keyword index. So two retrievers of one search read one connection and one contract, as Haystack's retrievers take their `document_store`.

The store's `metadata` reads the metadata of each passage from the other columns of its row, here with a zod schema's `parse`. Its result type `M` types the passages of the store and of every retriever over it, `StoredPassage<M>`, and their filters ([ADR 0015](./docs/adr/0015-a-passage-is-typed-by-its-metadata-and-only-a-stored-passage-has-source-seq-start-and-end.md)). A row that it refuses fails the call with its error. `metadata: (columns) => columns` keeps every column, untyped. The filter runs as SQL on the columns, so the reader may check, narrow or drop columns, but never rename them or convert their values: after a zod `.transform` that renames `set_id` to `setId` or turns a column into a `Date`, a filter on `metadata.setId` or on a `Date` compiles and fails at run time.

Each program below continues this program: it uses its `database`, `store`, `retriever` and `model`.

## Search passages by meaning

An embedding retriever embeds the query with its AI SDK model and sends one SQL query to the engine. The engine ranks the passages by cosine similarity: `vec_distance_cosine` on SQLite, pgvector's `<=>` on Postgres, `VECTOR_DISTANCE` on SQL Server ([ADR 0003](./docs/adr/0003-an-embedding-retriever-runs-the-vector-search-in-the-sql-of-its-engine-one-query-or-a-batch.md)). The score is `1 - cosine distance`. A tie goes to the smaller passage id.

An embedding retriever takes a `scoreThreshold`. Each list then keeps only the passages whose score is equal to or more than it, best first. The score is the cosine similarity, from -1 to 1, so the threshold reads one known scale, as Qdrant's `score_threshold` and the `similarity` of Elasticsearch's knn retriever do ([ADR 0019](./docs/adr/0019-a-score-threshold-belongs-to-the-embedding-retriever-or-to-rerank-where-the-scale-of-the-score-is-known.md)). A keyword retriever and a fusion take no threshold: the scale of their scores changes with the engine and with the query. The threshold is an option of the retriever, not of the call, so a `FusionRetriever` never gives it to its other retrievers. A `scoreThreshold` that is not a finite number is a `RangeError`.

```ts
const close = new SqliteEmbeddingRetriever({
  store,
  vectors: 'docs_passage_vectors',
  model,
  scoreThreshold: 0.75,
});
const { passages: closest } = await close.retrieve('How do I rotate a key?');
for (const { passage, score } of closest) {
  console.log(score.toFixed(3), passage.id);
}
```

Output:

```
1.000 vault-guide#0
```

`vault-guide#1` and `vault-guide#2` score 0.707, under the threshold.

An instruction-tuned model, such as Qwen3-Embedding, expects a task instruction before each query and none before a document. Wrap the model for the queries with the AI SDK's `wrapEmbeddingModel`, which keeps its provider and model id, so the stored vectors still match ([recipe](./docs/recipes/search-with-an-instruction-tuned-model.md)).

The retriever reads the model identity of the stored vectors first. When its query model has another provider or model id, the call fails with `ModelMismatchError` and sends no model call and no search. When the query vector has other dimensions than the stored vectors, the call fails with `DimensionMismatchError` of `@zukhruf/vectors` after the model call and sends no search ([ADR 0010](./docs/adr/0010-an-embedding-retriever-refuses-a-query-model-whose-identity-differs-from-the-stored-vectors.md)). The stand-in model below has no `doEmbed`, so a model call would fail with another error.

```ts
import { ModelMismatchError } from '@zukhruf/retrieval';

const other = new SqliteEmbeddingRetriever({
  store,
  vectors: 'docs_passage_vectors',
  model: new MockEmbeddingModelV4({
    provider: 'openai',
    modelId: 'text-embedding-3-small',
  }),
});
try {
  await other.retrieve('How do I rotate a key?');
} catch (error) {
  if (!(error instanceof ModelMismatchError)) throw error;
  console.log(error.message);
}
```

Output:

```
The query model openai/text-embedding-3-small is not the model of the stored vectors, toy/three-words
```

On Postgres, the store takes a session: one `query(sql, parameters, { signal })` method over the driver of the host, with positional parameters, `$1` for the first. So the package imports no driver. "Cancel a search" shows a session that cancels its query when the signal aborts.

```ts
import pg from 'pg';

import {
  PgvectorEmbeddingRetriever,
  PostgresPassageStore,
} from '@zukhruf/retrieval/postgres';

const pool = new pg.Pool({ connectionString: process.env['DATABASE_URL'] });
const pgStore = new PostgresPassageStore({
  session: {
    query: async (sql, parameters) =>
      (await pool.query(sql, [...parameters])).rows,
  },
  schema: 'rag', // the search_path of the session finds the relations when absent
  passages: 'docs_passages',
  metadata: Doc.parse,
});
const pgRetriever = new PgvectorEmbeddingRetriever({
  store: pgStore,
  vectors: 'docs_passage_vectors', // rag.docs_passage_vectors
  model,
});

const pgResults = await pgRetriever.retrieve('How do I rotate a key?', {
  topK: 3,
  signal: AbortSignal.timeout(10_000),
});
for (const { passage, score } of pgResults.passages) {
  console.log(score.toFixed(3), passage.id, passage.text);
}
```

Output:

```
1.000 vault-guide#0 Create a new key before you rotate the old key.
0.707 vault-guide#1  Then move each token to the new key.
0.707 vault-guide#2  Keep a backup of the old key for 30 days.
```

## Search by keywords

A keyword retriever queries the keyword index that elt writes: FTS5 on SQLite, `tsvector` on Postgres, full-text on SQL Server. A word of the user is never an operator of the engine. SQLite quotes each word as an FTS5 phrase. Postgres reads the text as `to_tsvector` does, so tsquery syntax is text. SQL Server's FREETEXT takes the text whole and has no operators, and CONTAINS quotes each word as a phrase. A query bundle can give it whole keywords in `keywords` (see "Give each search its own text"): each keyword is one phrase in the syntax of the engine, an FTS5 phrase, a `phraseto_tsquery` or a CONTAINS phrase, so `'heart failure'` matches those words side by side and in order, and not "failure of the heart". Its score is higher for a better match on every engine; `SqliteBM25Retriever` negates `bm25()` ([ADR 0004](./docs/adr/0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md)). How the words match is each engine's own `matching` option, a union typed for that engine only ([ADR 0018](./docs/adr/0018-each-keyword-retriever-matches-in-the-strongest-form-of-its-engine.md)): `{ operator: 'OR', cutoffFrequency? } | { operator: 'AND' }` on SQLite, `{ strategy: 'frequency', dropTokensThreshold? } | { strategy: 'all' }` on Postgres, which has no OR, and `{ predicate: 'FREETEXT' } | { predicate: 'CONTAINS', operator: 'AND' | 'OR' }` on SQL Server, where FREETEXT has no operator. SQL Server is `{ predicate: 'FREETEXT' }` when absent, its own natural-language form: a text goes whole to `FREETEXTTABLE`, which word-breaks it, adds the inflections of its words, ORs them and ranks with BM25, so CONTAINS syntax in it is text, and each keyword is a `FORMSOF(INFLECTIONAL, "…")` phrase of an `ISABOUT`, which a passage that holds any keyword matches. With no filter, when the passages are the table of the index, the engine stops ranking at `topK` (`top_n_by_rank`); with a filter, or passages that are a view, it ranks every match, because that cut comes before the join and the filter. Which passages of a tie at the cut survive follows the engine. Postgres is `{ strategy: 'frequency', dropTokensThreshold: 10 }` when absent (Meilisearch `matchingStrategy: 'frequency'`, Typesense `drop_tokens_threshold`): the AND of the lexemes of the text, as `to_tsvector` reads it, and while fewer than 10 passages match, the AND without the most frequent lexeme, by `pg_stats` of the column; a passage scores the lexemes it holds plus `ts_rank(…, 33)`. Through the retriever it gives nDCG@10 0.518 on SciFact, 0.295 on NFCorpus and 0.430 on TREC-COVID (AND 0.070, 0.206, 0.270), with a TREC-COVID p95 of 51 ms. SQLite is `{ operator: 'OR', cutoffFrequency: 20_000 }` when absent (Elasticsearch `cutoff_frequency`, Lucene `CommonTermsQuery`): a word in more than 20,000 passages only adds to the score of the passages that rarer words find, a query of only such words runs as their AND, and a word that no passage holds is left out. A `cutoffFrequency` under 1 is a share of the passages. Below 20,000 passages the default is plain OR. Through the retriever, with porter, it gives nDCG@10 0.686 on SciFact, 0.317 on NFCorpus and 0.545 on TREC-COVID (OR 0.585), and on TREC-COVID repeated four times (685,328 passages) a p95 of 200 to 247 ms against OR's 1,190 ms. OR alone has no bound, and `node:sqlite` cannot stop a running statement.

On SQLite the index is an FTS5 table whose external content is a keywords table, kept in step by triggers. The passages view gives the `rowid` of that table, and the retriever joins the passages on it ([ADR 0004](./docs/adr/0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md), the amendment of 2026-11-24).

```ts
import { SqliteBM25Retriever } from '@zukhruf/retrieval/sqlite';

// elt writes the keyword index: a keywords table with the rowid of each
// passage, and an FTS5 table with it as external content, kept in step by
// triggers. This program fills both once from the passages.
database.exec(`
  CREATE TABLE docs_keywords (rowid INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, source TEXT NOT NULL, seq INTEGER NOT NULL, text TEXT NOT NULL);
  CREATE VIRTUAL TABLE docs_passages_fts USING fts5(text, content = 'docs_keywords');
  INSERT INTO docs_keywords SELECT rowid, id, source, seq, text FROM docs_passages;
  INSERT INTO docs_passages_fts (docs_passages_fts) VALUES ('rebuild');
`);

const keywords = new SqliteBM25Retriever({ store, index: 'docs_passages_fts' });
const everyWord = new SqliteBM25Retriever({
  store,
  index: 'docs_passages_fts',
  matching: { operator: 'AND' }, // the default is { operator: 'OR', cutoffFrequency: 20_000 }
});

for (const search of [keywords, everyWord]) {
  const { passages } = await search.retrieve('backup mailbox');
  console.log(
    passages.map(({ passage, score }) => `${passage.id} ${score.toFixed(3)}`),
  );
}
```

Output:

```
[ 'mail-guide#0 1.918', 'vault-guide#2 0.543' ]
[ 'mail-guide#0 1.918' ]
```

On Postgres the query has to use the text search configuration of the index. `PgvectorKeywordRetriever` takes it in the index value, `index: { column, configuration }`, `'english'` when absent, as Haystack's `language`, LlamaIndex's `text_search_config` and LangChain's `tsv_lang` do. The configuration is a parameter of the statement, never SQL.

```ts
import { PgvectorKeywordRetriever } from '@zukhruf/retrieval/postgres';

const pgKeywords = new PgvectorKeywordRetriever({
  store: pgStore,
  index: {
    column: 'keywords', // GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED
    configuration: 'simple', // keeps stop words and does not stem
  },
});
console.log(
  (await pgKeywords.retrieve('backup mailbox')).passages.map(
    ({ passage }) => passage.id,
  ),
);
await pool.end();
```

Output:

```
[ 'mail-guide#0' ]
```

## Search SQL Server

`@zukhruf/retrieval/sqlserver` needs SQL Server 2025 or Azure SQL for `VECTOR` and `VECTOR_DISTANCE`, and Full-Text Search for the keyword retriever. The session takes named parameters, `@p0` for the key `p0`, as the SQL Server store of `@zukhruf/embedding-cache` does, so the package imports no driver.

```ts
import mssql from 'mssql';

import {
  SqlServerEmbeddingRetriever,
  SqlServerKeywordRetriever,
  SqlServerPassageStore,
} from '@zukhruf/retrieval/sqlserver';

const connection = await new mssql.ConnectionPool(
  process.env['SQLSERVER_URL'] ?? '',
).connect();
const msStore = new SqlServerPassageStore({
  session: {
    async query(sql, parameters) {
      const request = connection.request();
      for (const [name, value] of Object.entries(parameters)) {
        request.input(name, value);
      }
      return (await request.query(sql)).recordset ?? [];
    },
  },
  schema: 'rag', // the default schema of the user when absent
  passages: 'docs_passages',
  metadata: Doc.parse,
});
const msMeaning = new SqlServerEmbeddingRetriever({
  store: msStore,
  vectors: 'docs_passage_vectors', // [rag].[docs_passage_vectors]
  model,
});
const msKeywords = new SqlServerKeywordRetriever({
  store: msStore,
  index: { table: 'docs_passages' }, // the table with the full-text index on [text]
});

console.log(
  (
    await msMeaning.retrieve('How do I rotate a key?', { topK: 3 })
  ).passages.map(({ passage }) => passage.id),
);
console.log(
  (await msKeywords.retrieve('backup mailbox')).passages.map(
    ({ passage }) => passage.id,
  ),
);
await connection.close();
```

Output:

```
[ 'vault-guide#0', 'vault-guide#1', 'vault-guide#2' ]
[ 'mail-guide#0', 'vault-guide#2' ]
```

- **The vector search is exact.** `VECTOR_DISTANCE` reads every vector of the identity of the query; it uses no DiskANN index. The approximate `VECTOR_SEARCH` waits: on SQL Server 2025 it is a preview, filters after the search and needs a read-only table with an INT key ([ADR 0003](./docs/adr/0003-an-embedding-retriever-runs-the-vector-search-in-the-sql-of-its-engine-one-query-or-a-batch.md)).
- **Ids, sources and model identities compare in binary**, `Latin1_General_100_BIN2`, so `A` is not `a` and a tie orders as on SQLite and Postgres, whatever the collation of the database is. A filter compares in the collation of its column, usually case-insensitive.
- **The keyword index is a table.** `FREETEXTTABLE` and `CONTAINSTABLE` read a full-text index of a base table, never of a view, so `index.table` names the table whose full-text key is the passage id; the passages can be a view over it ([ADR 0004](./docs/adr/0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md)), and then the search ranks every match, since a cut before the join would drop passages. The score is `RANK`, from 0 to 1000 ([Limit search results with RANK](https://learn.microsoft.com/en-us/sql/relational-databases/search/limit-search-results-with-rank)).
- **Make the index with `STOPLIST = OFF`.** With the system stoplist, a stop word or a single letter in a CONTAINS `AND` query gives no passages. A word of punctuation only is dropped from the query, because SQL Server reads it as a stop word under every stoplist.
- **A query of more than 4,000 characters of condition fails** with SQL Server's error 4110: the driver binds the text as `NVARCHAR(MAX)`, which `FREETEXTTABLE` and `CONTAINSTABLE` refuse.

## Combine searches

`FusionRetriever` takes its retrievers by name, each with its weight: `retrievers: { [name]: { retriever, weight? } }`, as the `retrievers` of Elasticsearch's rrf and linear retrievers. It asks each retriever for `rankWindowSize` passages, fuses the lists on `Passage.id`, in the order of the names, and gives the best `topK`, each with its fused score ([ADR 0020](./docs/adr/0020-a-fusion-is-a-rank-fusion-or-a-score-fusion-over-ids-with-a-normalizer-for-each-list-and-a-combination.md), [ADR 0014](./docs/adr/0014-a-retrieve-call-answers-with-the-retrievers-that-answered-and-names-those-that-were-unavailable.md)). The fusion gets one input for each retriever, with its name and its weight. A weight is 1 when absent. A weight is a finite number of 0 or more, and at least one weight is above 0, as Haystack, Elasticsearch and LangChain require; else the `FusionRetriever` throws a `RangeError` that names the retriever when it is made ([ADR 0007](./docs/adr/0007-reciprocal-rank-fusion-is-the-default-fusion-with-k-60-and-ranks-from-1.md), the amendment of 2026-11-25). A weight of 0 gives its retriever no part in a score. A retriever that did not answer gives the fusion an empty list. A record of no retriever and a name that holds `:` do not compile; a record typed by `string` gets a `RangeError` for them at construction. `rankWindowSize` is the `topK` of the call when absent, and a `rankWindowSize` smaller than that `topK` is a `RangeError`. This program uses `keywords` of "Search by keywords".

```ts
import { FusionRetriever, ScoreFusion, minMax, sum } from '@zukhruf/retrieval';

const hybrid = new FusionRetriever({
  retrievers: { meaning: { retriever }, keywords: { retriever: keywords } },
  rankWindowSize: 50,
});
const scaled = new FusionRetriever({
  retrievers: {
    meaning: { retriever, weight: 0.75 },
    keywords: { retriever: keywords, weight: 0.25 },
  },
  fusion: new ScoreFusion({ normalizer: minMax(), combination: sum() }),
});

for (const search of [hybrid, scaled]) {
  const { passages } = await search.retrieve('rotate the old key', {
    topK: 3,
  });
  console.log(
    passages.map(({ passage, score }) => `${passage.id} ${score.toFixed(4)}`),
  );
}
```

Output:

```
[
  'vault-guide#0 0.0328',
  'vault-guide#1 0.0320',
  'vault-guide#2 0.0320'
]
[
  'vault-guide#0 1.0000',
  'vault-guide#2 0.0779',
  'vault-guide#1 0.0000'
]
```

`hybrid` has no `fusion`, so it fuses with `new RankFusion()`: reciprocal rank fusion with k 60 and ranks from 1. `vault-guide#0` is first in both lists, so it gets `1/61 + 1/61`. `scaled` has no `rankWindowSize`, so each retriever gives 3 passages. Min-max scaling gives the best passage of a list 1 and the worst 0, and a list whose scores are all equal gives 1.

A fusion is a rank fusion or a score fusion, after MongoDB's `$rankFusion` and `$scoreFusion` ([ADR 0020](./docs/adr/0020-a-fusion-is-a-rank-fusion-or-a-score-fusion-over-ids-with-a-normalizer-for-each-list-and-a-combination.md)):

- **`RankFusion` reads the order of each list only.** A rank normalizer gives each place its score, and a combination joins the weighted scores of an id. With no options it is reciprocal rank fusion, `reciprocalRank({ k: 60 })` and `sum()`, as `$rankFusion` is.
- **`ScoreFusion` reads the scores.** A score normalizer rescales each list from the statistics of its scores, `ListScores { min, max, mean, std, l2 }`, and a combination joins the weighted scores of an id. It takes both, with no default, because the leaders split on both: MongoDB `avg`, Elasticsearch and Qdrant `sum`, OpenSearch `arithmetic_mean`.

The package ships these strategies. A host writes its own as an object with `normalize` or `combine`.

| Strategy                | Kind             | Score                                                                                                         |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------- |
| `reciprocalRank({ k })` | rank normalizer  | `1 / (k + rank)`, ranks from 1; `k` is 60 when absent, and an integer of 1 or more                            |
| `minMax()`              | score normalizer | `(s - min) / (max - min)`; 1 when every score of the list is equal                                            |
| `distributionBased()`   | score normalizer | `(s - (mean - 3σ)) / ((mean + 3σ) - (mean - 3σ))`, with the population σ, not clipped; 0.5 when σ is 0        |
| `none()`                | score normalizer | `s`, as it is                                                                                                 |
| `sum()`                 | combination      | `Σ w·s` (CombSUM)                                                                                             |
| `max()`                 | combination      | the greatest `w·s` (CombMAX), so a weight of 0 gives 0 (#5585)                                                |
| `arithmeticMean()`      | combination      | `Σ w·s / Σ w` over the inputs that hold the id; 0 when `Σ w` is 0, as OpenSearch's `arithmetic_mean` gives it |

A retriever that gives an order only, such as a host's web search, gives ranked passages, with no score ([ADR 0021](./docs/adr/0021-a-retriever-says-whether-it-gives-scores-a-ranked-passage-has-none-and-a-scored-passage-always-has-one.md)). A `RankFusion` fuses its list beside a scored one by their order. Under a `ScoreFusion`, each retriever must give scored passages, or the `FusionRetriever` does not compile, as MongoDB's `$scoreFusion` refuses an input pipeline that gives no score. A missing score taken as 0, as LlamaIndex, Haystack and Eino take it, would tie every passage of that list with the best scored passage. A `ScoreFusion` refuses a score that is not finite with a `TypeError` that names the id and its input, and the core refuses a normalized or a fused score that is not finite, so a host strategy that gives NaN fails at once.

A fusion fuses ids, not passages, as Elasticsearch, OpenSearch and Qdrant do. So a host that holds only ids and scores calls `fuse` itself, as `@zukhruf/mteb` does for MTEB's hybrid search (#5400). Each input has a `name`, which every error names, its `docs`, best first, and its `weight`. This program fuses two lists on one scale with the greatest weighted score of each id (#5585), then with a host normalizer that divides each score by the L2 norm of its list, as Elasticsearch's `l2_norm` does, and the arithmetic mean.

```ts
import {
  type FusionInput,
  type ScoreDoc,
  type ScoreNormalizer,
  arithmeticMean,
  max,
  none,
} from '@zukhruf/retrieval';

const inputs: FusionInput<ScoreDoc>[] = [
  {
    name: 'labels',
    weight: 1,
    docs: [
      { id: 'd1', score: 0.9 },
      { id: 'd2', score: 0.5 },
    ],
  },
  {
    name: 'trials',
    weight: 2,
    docs: [
      { id: 'd2', score: 0.3 },
      { id: 'd3', score: 0.2 },
    ],
  },
];

const greatest = new ScoreFusion({ normalizer: none(), combination: max() });
console.log(greatest.fuse(inputs));

const byNorm: ScoreNormalizer = { normalize: (score, list) => score / list.l2 };
const averaged = new ScoreFusion({
  normalizer: byNorm,
  combination: arithmeticMean(),
});
console.log(averaged.fuse(inputs));
```

Output:

```
[
  { id: 'd1', score: 0.9 },
  { id: 'd2', score: 0.6 },
  { id: 'd3', score: 0.4 }
]
[
  { id: 'd1', score: 0.8741572761215378 },
  { id: 'd2', score: 0.7165811732847732 },
  { id: 'd3', score: 0.5547001962252291 }
]
```

Under `max()`, `d2` gets 0.6, the 0.3 of `trials` times its weight 2, which is more than its 0.5 of `labels`; a sum would give it 1.1. `arithmeticMean()` divides by the weights of the inputs that hold the id, so `d3`, which only `trials` holds, keeps its normalized score, 0.555.

The retrievers run at once, and the call answers with the retrievers that answered ([ADR 0014](./docs/adr/0014-a-retrieve-call-answers-with-the-retrievers-that-answered-and-names-those-that-were-unavailable.md)):

- **A retriever that throws `RetrieverUnavailableError` is left out**, and `failures` names it, as Elasticsearch's `skip_unavailable` skips a cluster. A host adapter throws it, or a subclass of it, when its source cannot answer: HTTP 503 or 429, a timeout of its own, a refusal.
- **A fusion inside a fusion names its failures by path**: `literature:pubmed` is the retriever `pubmed` of the retriever `literature`, as Elasticsearch writes `cluster:index`. So a name holds no `:`.
- **When no retriever answered, the call throws `NoRetrieverAnsweredError`.** It is a `RetrieverUnavailableError`, so a fusion that got no answer is an unavailable retriever of the fusion above it. An empty list would read as "nothing found".
- **Any other error is a bug.** It aborts the signal of every other retriever, with the error as the reason, as Go's `errgroup.WithContext` cancels with its cause, and the call rejects with it.
- **When the caller aborts, the call rejects at once with the signal's reason**, even while a retriever ignores its signal.

`MultiQueryRetriever` asks a language model for `queryCount` other versions of the query, 4 when absent. It searches the query and each version, and fuses the lists as the inputs `query`, `version 1` … `version n`, each with a weight of 1, with `new RankFusion()` when it has no `fusion` ([ADR 0008](./docs/adr/0008-a-search-is-composed-of-retrievers-that-wrap-retrievers-and-a-list-of-postprocessors.md)). It searches a query bundle as the caller gives it, first, and each version as a plain string, so its retriever takes a plain query ([ADR 0013](./docs/adr/0013-a-query-is-a-string-or-a-query-bundle-with-a-text-for-each-kind-of-search.md)). It gives scored passages, the fused scores, and its retriever follows the rule of `FusionRetriever`: any retriever under a `RankFusion`, a scored one under a `ScoreFusion`. The searches run at once as the retrievers of a `FusionRetriever` do: an error of one search aborts the others with the error as the reason, and an abort of the caller rejects at once. It catches no error, a `RetrieverUnavailableError` too: every search reads the one retriever, so the call rejects with it. This program continues the one above.

```ts
import { MockLanguageModelV4 } from 'ai/test';

import { MultiQueryRetriever } from '@zukhruf/retrieval';

// A stand-in language model that writes the versions of the query. Give an
// AI SDK model in its place, such as openai('gpt-5-mini').
const languageModel = new MockLanguageModelV4({
  doGenerate: async () => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          queries: [
            'replace a key',
            'key rotation',
            'new key',
            'token of a key',
          ],
        }),
      },
    ],
    finishReason: { unified: 'stop', raw: 'stop' },
    usage: {
      inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  }),
});

// The query and the 4 versions that the model writes: 5 lists, which
// new RankFusion() fuses.
const expanded = new MultiQueryRetriever({
  retriever: hybrid,
  model: languageModel,
});
const found = await expanded.retrieve('rotate a key', { topK: 3 });
console.log(
  found.passages.map(
    ({ passage, score }) => `${passage.id} ${score.toFixed(4)}`,
  ),
);
```

Output:

```
[
  'vault-guide#1 0.0799',
  'vault-guide#0 0.0656',
  'vault-guide#2 0.0640'
]
```

`HydeRetriever { retriever, model }` asks the language model for a passage that answers the `query`, and gives that passage to the embedding search only, as `customEmbeddings: [passage]`. The `query` and the `keywords` stay, so a reranker below it still ranks against the question. Its retriever takes any query bundle: a host source that needs its own field is fused beside it, `new FusionRetriever({ retrievers: { issues: { retriever: new IssueRetriever() }, hyde: { retriever: new HydeRetriever({ retriever: embeddings, model }) } } })`, since only an embedding search reads the passage ([ADR 0013](./docs/adr/0013-a-query-is-a-string-or-a-query-bundle-with-a-text-for-each-kind-of-search.md)). The passage replaces any `customEmbeddings` of the caller, so the embedding search reads the passage alone, as LangChain's [`HydeRetriever`](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-classic/src/retrievers/hyde.ts) and Haystack's [HyDE recipe](https://docs.haystack.deepset.ai/docs/hypothetical-document-embeddings-hyde) do; LlamaIndex's [`HyDEQueryTransform`](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/indices/query/query_transform/base.py) keeps them by default (`include_original=True`). A `HydeRetriever` gives the kind of passage that its retriever gives: scored over an engine, ranked over a host's retriever of order only ([ADR 0021](./docs/adr/0021-a-retriever-says-whether-it-gives-scores-a-ranked-passage-has-none-and-a-scored-passage-always-has-one.md)).

## Rerank and post-process the results

`RerankRetriever { retriever, model, rankWindowSize?, topN?, scoreThreshold? }` reranks the passages of its retriever with an AI SDK reranking model, as Elasticsearch's `text_similarity_reranker` retriever reranks a child retriever and LangChain's `ContextualCompressionRetriever` runs a reranker over its base retriever ([ADR 0021](./docs/adr/0021-a-retriever-says-whether-it-gives-scores-a-ranked-passage-has-none-and-a-scored-passage-always-has-one.md)). Its retriever may give an order only. Each passage that the model ranks gets the relevance of the model as its score, best first, so a `RerankRetriever` gives scored passages over any retriever. A passage that the model leaves out, past `topN`, is dropped. The call gives the best `topK` of the rest; "Rerank a window of candidates" asks the retriever for more than that.

`PostprocessingRetriever` runs a list of postprocessors, in order, on the result of its retriever ([ADR 0008](./docs/adr/0008-a-search-is-composed-of-retrievers-that-wrap-retrievers-and-a-list-of-postprocessors.md)). Each postprocessor gets the list of the one before it, the `query` of the query bundle (the information need, a string) and the abort signal of the call. It gives the kind of passage that its retriever gives, and each postprocessor takes that kind: over a `RerankRetriever` the list stays scored. The call gives the first `topK` passages of the last postprocessor. This program continues the one of "Combine searches".

```ts
import { MockRerankingModelV4 } from 'ai/test';

import {
  Collapse,
  ContextWindow,
  LongContextReorder,
  MaximalMarginalRelevance,
  PostprocessingRetriever,
  RerankRetriever,
} from '@zukhruf/retrieval';

// A stand-in reranking model: the relevance is the share of the query's words
// in the text. Give an AI SDK reranking model in its place, such as
// cohere.reranking('rerank-v3.5').
const rerankingModel = new MockRerankingModelV4({
  doRerank: async ({ documents, query, topN }) => {
    const asked = query.toLowerCase().split(/\W+/).filter(Boolean);
    return {
      ranking: documents.values
        .map((text, index) => {
          const said = String(text).toLowerCase().split(/\W+/);
          const share =
            asked.filter((word) => said.includes(word)).length / asked.length;
          return { index, relevanceScore: share };
        })
        .toSorted((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, topN),
    };
  },
});

const search = new PostprocessingRetriever({
  retriever: new RerankRetriever({
    retriever: hybrid,
    model: rerankingModel,
    topN: 20,
    scoreThreshold: 0.2, // keeps a relevance of 0.2 or more
  }),
  postprocessors: [
    new MaximalMarginalRelevance({ model, lambda: 0.5, topK: 4 }), // lambda 1 = relevance only
    new Collapse({ field: 'source', size: 1 }), // one passage for each source
    new ContextWindow({ store, windowSize: 1 }), // the store of the retrievers
    new LongContextReorder(),
  ],
});

const widened = await search.retrieve('rotate the old key backup', {
  topK: 10,
  includeVectors: true, // MaximalMarginalRelevance compares the vectors
});
for (const { passage, score } of widened.passages) {
  console.log(
    score.toFixed(2),
    passage.id,
    `[${passage.start}, ${passage.end})`,
    passage.text,
  );
}
```

Output:

```
0.20 mail-guide#0 [0, 42) Make a backup of each mailbox every night.
0.80 vault-guide#2 [47, 126)  Then move each token to the new key. Keep a backup of the old key for 30 days.
```

The score of each passage is the relevance of the reranking model. `RerankRetriever` keeps a passage only when that relevance is equal to or more than its `scoreThreshold`, 0.2 here: the threshold reads the scale of its model, as the `score_threshold` of Haystack's rankers does ([ADR 0019](./docs/adr/0019-a-score-threshold-belongs-to-the-embedding-retriever-or-to-rerank-where-the-scale-of-the-score-is-known.md)). `Collapse` keeps the first passage of each source, in the order of the list: a list is best first, so the first passage of a source is its best. It reads no score, so it keeps the order in which `MaximalMarginalRelevance` picked the passages, as Elasticsearch's `collapse` keeps the top hit of each key in the order of the search's sort ([ADR 0021](./docs/adr/0021-a-retriever-says-whether-it-gives-scores-a-ranked-passage-has-none-and-a-scored-passage-always-has-one.md)). A `Collapse` keeps the field as written, and its `postprocess` takes only passages that have that field, so the list checks the field against the passages of its retriever: over an engine of `z.infer<typeof Doc>`, `new Collapse({ field: 'metadata.prodcut' })` does not compile, while a key of the metadata, a stored field such as `seq`, and `new Collapse()` (the `source`) do; over a store whose `metadata` is the bag `(columns) => columns`, any key compiles. Over a live retriever, name the passage type, `new Collapse<Passage<z.infer<typeof Doc>>>({ field: 'metadata.product' })`: without a type argument a `Collapse` is one of stored passages. `ContextWindow` takes the `M` of its store, so the store of another typed `M` does not compile; the bag store compiles, since every `M` is a bag, and it does no harm: a window keeps the passage's own metadata. `ContextWindow` widens `vault-guide#2` to the passages of its source from `seq - 1` to `seq + 1`: its text is the exact part of the source from the `start` to the `end` of the window, because the passages of a source tile it. A window whose passages leave a gap fails with `PassageGapError`, which names the source and the offsets of the gap ([ADR 0008](./docs/adr/0008-a-search-is-composed-of-retrievers-that-wrap-retrievers-and-a-list-of-postprocessors.md), the amendment of 2026-11-24). `LongContextReorder` puts the best passage at the end of a list of two.

`MaximalMarginalRelevance` compares the vectors of the passages, so its retriever runs with `includeVectors: true`. Its `model` embeds the query, and the relevance of a passage is the cosine similarity of the two vectors ([ADR 0008](./docs/adr/0008-a-search-is-composed-of-retrievers-that-wrap-retrievers-and-a-list-of-postprocessors.md), the amendment of 2026-11-23). It gives the passages in the order in which it picks them, so its list is not sorted by score, as after `LongContextReorder` ([ADR 0005](./docs/adr/0005-a-score-is-higher-for-a-better-passage.md)).

A host writes its own postprocessor for its passage type and kind: `Postprocessor<P, I>`, where `I` is `RankedPassage<P>` or `ScoredPassage<P>`. A postprocessor of order only, such as a pin that adds a passage without a score, does not compile over a scored retriever, because a scored list would then hold a passage without a score. Type the retriever as `Retriever<Q, P>` first, an order only, and then it compiles. The package's postprocessors keep the kind they get, so they go over a list of either kind.

## Rerank by meaning with an embedding model

`EmbeddingRerankRetriever { retriever, model, rankWindowSize?, topN?, scoreThreshold? }` reranks the passages of its retriever with an AI SDK embedding model, as LangChain's `EmbeddingsFilter` does inside a `ContextualCompressionRetriever` ([ADR 0022](./docs/adr/0022-a-reranker-may-embed-the-text-of-the-candidates-when-the-query-runs.md)). It is the reranker for a host that has an embedding model and no reranking model, and for a live source, which has no stored vectors. When the query runs, the model embeds the `query` of the query bundle and the text of each passage, in two calls at once. Each passage gets the cosine similarity of the two vectors as its score, from -1 to 1, best first, and, when the call passes `includeVectors: true`, the vector that the model made. An information need that is empty or white space only is a `RangeError` before any call. It keeps the passages whose score is equal to or more than `scoreThreshold`, then the best `topN`, a positive integer. Its retriever may give an order only, so a live source in an `EmbeddingRerankRetriever` gives scored passages and goes under a `ScoreFusion`.

```ts
import { MockEmbeddingModelV4 } from 'ai/test';

import {
  EmbeddingRerankRetriever,
  MaximalMarginalRelevance,
  type Passage,
  PostprocessingRetriever,
  type Retriever,
} from '@zukhruf/retrieval';

// A host adapter for a web search: an order only, no score, no vector.
const pages = [
  'Make a backup of each mailbox every night.',
  'Rotate the signing key every 90 days.',
  'Keep a backup of the old key for 30 days.',
  'Rotate the old key, then move each token to the new key.',
];
const web: Retriever<string, Passage> = {
  retrieve: async () => ({
    passages: pages.map((text, index) => ({
      passage: { id: `web-${index + 1}`, text, metadata: {} },
    })),
    failures: new Map(),
  }),
};

// A stand-in embedding model: a count of six words. Give an AI SDK embedding
// model in its place, such as openai.embedding('text-embedding-3-small').
const words = ['key', 'rotate', 'backup', 'mailbox', 'token', 'old'];
const embeddingModel = new MockEmbeddingModelV4({
  doEmbed: async ({ values }) => ({
    embeddings: values.map((text) => {
      const said = text.toLowerCase().split(/\W+/);
      return words.map((word) => said.filter((w) => w === word).length);
    }),
    warnings: [],
  }),
});

const search = new PostprocessingRetriever({
  retriever: new EmbeddingRerankRetriever({
    retriever: web,
    model: embeddingModel,
    topN: 3,
    scoreThreshold: 0.5, // keeps a cosine similarity of 0.5 or more
  }),
  postprocessors: [
    // The same model: it compares the vectors the reranker made.
    new MaximalMarginalRelevance({
      model: embeddingModel,
      lambda: 0.3,
      topK: 2,
    }),
  ],
});

const { passages } = await search.retrieve('rotate the old key', {
  includeVectors: true, // MaximalMarginalRelevance compares the vectors the reranker made
});
for (const { passage, score } of passages) {
  console.log(score.toFixed(3), passage.id, passage.text);
}
```

Output:

```
0.873 web-4 Rotate the old key, then move each token to the new key.
0.667 web-3 Keep a backup of the old key for 30 days.
```

The web search gave web-1 to web-4 in its own order. The reranker scores web-4 0.873, web-2 0.816, web-3 0.667 and web-1 0, and the threshold drops web-1. `MaximalMarginalRelevance` alone fails over this source with `VectorMissingError`, since a web search gives no vector; after the reranker it compares the vectors that the reranker made, which a call gets with `includeVectors: true`, as from an engine, and without it MMR fails with `VectorMissingError` here too. It picks web-4 first, then weighs each other passage as `lambda * relevance - (1 - lambda) * redundancy`, where the redundancy is the cosine similarity to web-4: web-2 is more relevant (0.816 against 0.667) but repeats more of web-4 (0.802 against 0.655), so at `lambda: 0.3` web-3 wins (-0.258 against -0.316), and at the default of 0.5 web-2 would win. Give it the model of the reranker: a vector of another model is in another vector space ([ADR 0010](./docs/adr/0010-an-embedding-retriever-refuses-a-query-model-whose-identity-differs-from-the-stored-vectors.md)). For the same reason the reranker replaces a vector that its retriever gives. `RerankRetriever` sends `topN` to its reranking model; an embedding model has none, so `EmbeddingRerankRetriever` cuts its sorted list itself. Each query costs one `embed` of the query and one `embedMany` of the candidates; `@zukhruf/embedding-cache` can wrap the model so that a text is embedded once.

## Rerank a window of candidates

`rankWindowSize` is how many passages a composite asks of its retriever before it reranks or diversifies them: its retriever gets the options of the call with the window as their `topK`, and the call gives the best `topK` of the result, as Elasticsearch's `text_similarity_reranker` and `diversify` retrievers take `rank_window_size` ([ADR 0023](./docs/adr/0023-a-composite-that-fuses-reranks-or-diversifies-asks-its-retriever-for-a-rank-window-and-gives-the-topk-of-the-call.md)). `RerankRetriever`, `EmbeddingRerankRetriever`, `PostprocessingRetriever` and `FusionRetriever` take it. Without it, the window is the `topK` of the call, so the reranker can only reorder the passages that the call gives. This program continues the one of "Rerank by meaning with an embedding model".

```ts
import { PostprocessingRetriever } from '@zukhruf/retrieval';

// The web search above, now giving the first topK pages, as the page size of
// a search API does.
const paged: Retriever<string, Passage> = {
  retrieve: async (query, options = {}) => {
    const { passages, failures } = await web.retrieve(query);
    return { passages: passages.slice(0, options.topK ?? 10), failures };
  },
};

const narrow = new EmbeddingRerankRetriever({
  retriever: paged,
  model: embeddingModel,
});
const windowed = new EmbeddingRerankRetriever({
  retriever: paged,
  model: embeddingModel,
  rankWindowSize: 4, // the reranker asks for 4 and gives the topK of the call
});
// A host screen, such as one that drops a retracted article, goes in an outer
// PostprocessingRetriever with no window: it runs on the topK passages only.
const screened = new PostprocessingRetriever({
  retriever: windowed,
  postprocessors: [
    {
      postprocess: async (passages) =>
        passages.filter(({ passage }) => passage.id !== 'web-2'),
    },
  ],
});

for (const [name, search] of Object.entries({ narrow, windowed, screened })) {
  const { passages } = await search.retrieve('rotate the old key', { topK: 2 });
  console.log(
    name,
    passages.map(({ passage, score }) => `${passage.id} ${score.toFixed(3)}`),
  );
}
```

Output:

```
narrow [ 'web-2 0.816', 'web-1 0.000' ]
windowed [ 'web-4 0.873', 'web-2 0.816' ]
screened [ 'web-4 0.873' ]
```

`narrow` gets web-1 and web-2 from the search and can only reorder them. `windowed` gets all four, and web-4, the best, is the fourth in the search's order. `screened` drops web-2 after the cut, so the call gives one passage: a screen in the same composite as the window would run on all four and could give web-3 in its place. A window smaller than the `topK` of the call is a `RangeError` before the retriever or the model is called, as Elasticsearch refuses a `rank_window_size` smaller than `size`, and a `rankWindowSize` that is not a positive integer is a `RangeError` when the composite is made. Over a `FusionRetriever`, a composite's window is the fusion's `topK`, so the fusion's own `rankWindowSize` must be at least that window. A `PostprocessingRetriever` with a `rankWindowSize` takes at least one postprocessor: `postprocessors: []` with a window does not compile. `MaximalMarginalRelevance` in a window picks from all of it. `topN` is not needed in a window, and a `topN` below `topK` gives fewer passages, as Cohere's `top_n` does.

## Give each search its own text

A query is a string or a query bundle, `{ query, keywords?, customEmbeddings? }`, after LlamaIndex's `QueryBundle` ([ADR 0013](./docs/adr/0013-a-query-is-a-string-or-a-query-bundle-with-a-text-for-each-kind-of-search.md)). `query` is the information need: the reranker reads it, and so does every search that has no text of its own. A keyword retriever matches each keyword of `keywords` as one phrase in place of the words of `query`. An embedding retriever embeds the texts of `customEmbeddings` in place of `query`, and searches with the mean of their vectors; a text of no word to embed, a blank `query` or a blank text of `customEmbeddings`, is a `RangeError` before it reads the store or calls its model. `FusionRetriever` gives each retriever the bundle unchanged, so each reads its own text. A string is a bundle with only `query`. This program continues the one of "Rerank and post-process the results".

```ts
import type {
  Passage,
  QueryBundle,
  RetrievalResult,
  RetrieveOptions,
  Retriever,
} from '@zukhruf/retrieval';

// A keyword search of the question matches any of its words, "How" and
// "do" too.
const question = 'How do I rotate the old key?';
console.log(
  'keywords of the question:',
  (await keywords.retrieve(question)).passages.length,
);

const reranked = new RerankRetriever({
  retriever: hybrid, // the fusion of the embedding and the keyword retriever
  model: rerankingModel,
  topN: 2,
});
const own = await reranked.retrieve({
  query: question, // the reranker ranks against it; the embedding search embeds it
  keywords: ['rotate', 'key'], // the keyword search matches these
});
console.log(
  own.passages.map(({ passage, score }) => `${passage.id} ${score.toFixed(2)}`),
);

// A host adapter for a source with its own syntax declares its field in its
// own bundle type. Then it takes no string. Its passage is not a row of the
// passage contract, so it has no source, seq, start or end. Its source gives
// an order only, so its passages have no score. Its metadata has the type of
// the store's, so it fuses with the keyword retriever.
type IssueQueryBundle = QueryBundle & { readonly jql: string };
type Issue = Passage<z.infer<typeof Doc>>;
class IssueRetriever implements Retriever<IssueQueryBundle, Issue> {
  async retrieve(
    query: IssueQueryBundle,
    options: RetrieveOptions<Issue> = {},
  ): Promise<RetrievalResult<Issue>> {
    console.log('issues got:', query.jql);
    const passage = {
      id: 'VAULT-12',
      text: 'Rotate the signing key of the vault after a leak.',
      metadata: { product: 'vault', year: 2025 },
    };
    return {
      passages: [{ passage }].slice(0, options.topK ?? 10),
      failures: new Map(),
    };
  }
}

// The reranking model of "Rerank and post-process the results", which also
// says what it ranks against.
const told = new MockRerankingModelV4({
  doRerank: async (options) => {
    console.log('reranker got:', options.query);
    return rerankingModel.doRerank(options);
  },
});
const federation = new RerankRetriever({
  retriever: new FusionRetriever({
    retrievers: {
      issues: { retriever: new IssueRetriever() },
      keywords: { retriever: keywords },
    },
  }),
  model: told,
  topN: 2,
});
const answers = await federation.retrieve({
  query: question,
  keywords: ['rotate', 'key'],
  jql: 'project = VAULT AND text ~ "rotate key"',
});
console.log(
  answers.passages.map(
    ({ passage, score }) => `${passage.id} ${score.toFixed(2)}`,
  ),
);
```

Output:

```
keywords of the question: 3
[ 'vault-guide#0 0.57', 'vault-guide#2 0.43' ]
issues got: project = VAULT AND text ~ "rotate key"
reranker got: How do I rotate the old key?
[ 'vault-guide#0 0.57', 'VAULT-12 0.43' ]
```

`federation.retrieve(question)` does not compile: the issue search needs `jql`, and a string has none. `new MultiQueryRetriever({ retriever: federation, model })` does not compile either: a version of the query is a plain string. TypeScript infers the query type of a fusion from its retrievers. Two retrievers that each need a field of their own take the type argument: `new FusionRetriever<A & B>({ retrievers })`. A type argument makes the names `string`, as TypeScript infers all type arguments or none, so the constructor checks the names at run time.

## Search many queries at once

Batch search is part of vector search. Each embedding retriever has `retrieveMany` beside `retrieve`. Each query is a string or a query bundle. It embeds the texts of the queries in one `embedMany` call and runs one SQL query: a `VALUES` table of the query vectors on SQLite, `CROSS JOIN LATERAL` on Postgres, `CROSS APPLY` over the query vectors of one `OPENJSON` parameter on SQL Server ([ADR 0003](./docs/adr/0003-an-embedding-retriever-runs-the-vector-search-in-the-sql-of-its-engine-one-query-or-a-batch.md)).

```ts
const lists = await retriever.retrieveMany(
  [
    'rotate a key',
    { query: 'I lost my phone', customEmbeddings: ['revoke a token'] },
  ],
  { topK: 2 },
);
// lists[0] is the result of 'rotate a key', lists[1] of 'revoke a token'
for (const { passages } of lists) {
  console.log(passages.map(({ passage }) => passage.id));
}
```

Output:

```
[ 'vault-guide#0', 'vault-guide#1' ]
[ 'vault-faq#0', 'vault-faq#1' ]
```

## Filter by metadata

A filter has Haystack's shape: AND, OR and NOT over `== != > >= < <= in "not in"` ([ADR 0009](./docs/adr/0009-a-filter-has-the-shape-of-haystacks-filters.md)). A field is a passage field (`source`, `seq`, `start`, `end`) or a metadata column, `metadata.<column>`. A metadata column is each column of the passages other than `id, source, seq, start, end, text` (and `rowid` on SQLite). An engine retriever runs the filter as SQL `WHERE` in the same query. The filter is typed by the passage type of its retriever, `Filter<P>`: an engine retriever's filter can name `source`, `seq`, `start` and `end`, and a live source's cannot, since its passages have none. Its metadata fields are those of the store's `M`, each with its type, so with `Doc.parse` a filter on `metadata.yaer` (TS2820) or on a `year` of `'2025'` (TS2322) does not compile. `M` names the columns as they are, since the SQL reads them: a reader that renames a column or converts its value types a filter that the SQL cannot run ([ADR 0015](./docs/adr/0015-a-passage-is-typed-by-its-metadata-and-only-a-stored-passage-has-source-seq-start-and-end.md)).

```ts
const filtered = await retriever.retrieve('rotate a key', {
  filter: {
    operator: 'AND',
    conditions: [
      { field: 'metadata.product', operator: '==', value: 'vault' },
      { field: 'metadata.year', operator: '>=', value: 2025 },
    ],
  },
});
for (const { passage, score } of filtered.passages) {
  console.log(score.toFixed(3), passage.id, passage.metadata);
}
```

Output:

```
1.000 vault-guide#0 { product: 'vault', year: 2025 }
0.707 vault-guide#1 { product: 'vault', year: 2025 }
0.707 vault-guide#2 { product: 'vault', year: 2025 }
```

On Postgres, pgvector filters after the approximate index scan, so a filtered call can give fewer than `topK` passages ([pgvector README](https://github.com/pgvector/pgvector/blob/master/README.md)).

## Cancel a search

Every async call of the package takes an optional `signal`, the name of `fetch` and Node ([ADR 0017](./docs/adr/0017-every-async-port-takes-an-optional-abort-signal-and-a-composite-rejects-at-once-when-it-aborts.md)): `retrieve`, `retrieveMany`, `postprocess`, the store's `get` and `neighbours`, and the session's `query`. Each built-in passes the signal to every async call it makes: an engine retriever and a store to the session, `ContextWindow` to the store, and each composite to its retrievers, postprocessors and model. The AI SDK names it `abortSignal`, and the package maps `signal` onto it at its own model calls. An aborted call rejects with the signal's reason. A composite (`FusionRetriever`, `MultiQueryRetriever`, `RerankRetriever`, `PostprocessingRetriever`, `HydeRetriever`) rejects at once when the signal aborts, even while a part of it ignores its signal. An abort is never a failure in `failures`.

A session cancels its query on the server. node-postgres takes no signal, so this session cancels with `pg_cancel_backend`:

```ts
import { addAbortListener } from 'node:events';

const cancelling: PostgresSession = {
  async query(sql, parameters, { signal } = {}) {
    const client = await pool.connect();
    let cancelled: Promise<unknown> | undefined;
    try {
      const [backend] = (await client.query('SELECT pg_backend_pid() AS pid'))
        .rows;
      using _listening =
        signal === undefined
          ? undefined
          : addAbortListener(signal, () => {
              cancelled = pool.query('SELECT pg_cancel_backend($1)', [
                backend?.pid,
              ]);
            });
      try {
        const { rows } = await client.query(sql, [...parameters]);
        signal?.throwIfAborted(); // an abort the cancel came too late for
        return rows;
      } catch (error) {
        signal?.throwIfAborted(); // the reason, not "canceling statement due to user request"
        throw error;
      }
    } finally {
      // The cancel ends before the client goes back to the pool, so it
      // cannot cancel the query of the next borrower of this backend.
      try {
        await cancelled;
      } finally {
        client.release();
      }
    }
  },
};
```

On SQL Server, the session cancels with mssql's `request.cancel()` in the same way. SQLite runs a statement synchronously, so its store and retrievers check the signal before the statement, and the embedding retriever after the model call too.

## Errors

| Error                                         | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ModelMismatchError`                          | The query model of an embedding retriever has another provider or model id than the stored vectors, before the model call. `stored` and `query` are each `{ provider, modelId }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `DimensionMismatchError` (`@zukhruf/vectors`) | The query vector has other dimensions than the stored vectors, after the model call. `expected` and `actual`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `VectorMissingError`                          | `MaximalMarginalRelevance` gets a passage without a vector: the call did not ask for vectors. `passageId`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `PassageGapError`                             | `ContextWindow` gets a window whose passages leave a gap in their source: the writer of the contract broke it. `source`, and `start` and `end` of the gap                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `NoRetrieverAnsweredError`                    | No retriever of a `FusionRetriever` answered: each threw `RetrieverUnavailableError`. `failures` names each, by path when nested, and the cause is an `AggregateError` of them. It is a `RetrieverUnavailableError`, so the fusion above leaves it out                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `RangeError`                                  | An option out of its range: a `FusionRetriever` of no retriever or with a name that holds `:`; a `rankWindowSize` of `FusionRetriever`, `RerankRetriever`, `EmbeddingRerankRetriever` or `PostprocessingRetriever` that is not a positive integer, when it is made, or that is smaller than the `topK` of the call, before any retriever or model is called; a `queryCount`, `topK` of MMR or `windowSize` that is not a positive integer; a `lambda` outside 0 to 1; a `topN` of `RerankRetriever` or `EmbeddingRerankRetriever` that is not a positive integer; a `scoreThreshold` of an embedding retriever, of `RerankRetriever` or of `EmbeddingRerankRetriever` that is not a finite number; a weight of a fusion input or of a `FusionRetriever` entry that is not a finite number of 0 or more (the message names the input or the retriever), or weights of which none is above 0; a `k` of `reciprocalRank` that is not an integer of 1 or more; a `topK` of a call that is not a whole number of 0 or more (a negative, 2.5, NaN, Infinity), to any retriever, before any statement, retriever or model call; an information need that is empty or white space only, to `EmbeddingRerankRetriever`, `RerankRetriever`, `HydeRetriever`, `MultiQueryRetriever` or `MaximalMarginalRelevance`, before any retriever or model call |
| `TypeError`                                   | A filter field that is not a passage field or `metadata.<column>`, an `in` or `not in` value that is not an array, or a stored model identity that is not of the form `provider/model (n dimensions)`. A score that is not finite (NaN or an infinity): in an input of `ScoreFusion` (the message names the id and its input), from a normalizer (the id and its input) or a combination (the id and the inputs that hold it) of either fusion, or from the model of `RerankRetriever`; a cosine similarity that is not finite in `EmbeddingRerankRetriever`, as from a zero vector (the message names the passage). A host fusion in a `FusionRetriever` or a `MultiQueryRetriever` that gives an id of no input                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

An error of the model, of the engine, of the store's `metadata`, of the reranking model or of the embedding model of `EmbeddingRerankRetriever` reaches the caller as it is. An aborted call rejects with the reason of its `signal` ("Cancel a search").

## What the package does not do

- **It does not cut documents or write vectors.** elt loads, cuts and embeds them, and writes the passage contract (elt #5401). Cutting text moves to its own zukhruf package (#5414) ([ADR 0001](./docs/adr/0001-the-package-is-the-query-side-of-rag-and-reads-a-passage-contract-that-elt-writes.md)). Only `EmbeddingRerankRetriever` embeds a passage, the candidates of one query when it runs, and it keeps no vector ([ADR 0022](./docs/adr/0022-a-reranker-may-embed-the-text-of-the-candidates-when-the-query-runs.md)).
- **It does not ship adapters for live sources.** A web search or the API of a product is an adapter of the host that implements `Retriever`, with its own fields in its own query bundle type ([ADR 0002](./docs/adr/0002-a-retriever-is-a-port-for-any-source.md), [ADR 0013](./docs/adr/0013-a-query-is-a-string-or-a-query-bundle-with-a-text-for-each-kind-of-search.md)).
- **It does not make agent tools.** An AI SDK tool over a retriever is the consumer's code.
- **It does not write the keyword index or the vector index.** elt writes both; this package only queries them ([ADR 0004](./docs/adr/0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md)).

## Who uses it

Each consumer moves to the fusions and the ranked and scored passages of #5400 when it takes this release.

| Consumer        | How                                                                                                                                                                                                                                                             | Record       |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| April           | its bridge's task search fuses `SqliteEmbeddingRetriever` and `SqliteBM25Retriever` with `FusionRetriever` over an elt Vectorizer's contract, then keeps one passage of each task with `Collapse`; its hand collapse of passages to documents became `Collapse` | #5407        |
| text2sql        | the google-tasks and agent-backlog searches of its playground fuse the SQLite keyword and embedding retrievers with `FusionRetriever`, in place of the two `toFtsQuery` copies                                                                                  | #5410        |
| elt             | the tests of `@eltjs/vectorizer` read the passage contract that it writes with the retrievers of each engine                                                                                                                                                    | elt #5401    |
| deepagents      | nothing moves: deepagents 9564ec80 (7.30.1, 2026-11-24) deleted `@deepagents/retrieval`, toolbox `search_content_tool` and the orchestrator code that used it, and no connector moved to elt (elt #5405)                                                        | #5406        |
| deepagents      | `ContextStore.searchMessages` (FTS5, `ts_rank`, `CONTAINSTABLE`) moves to the keyword retrievers, with one score direction                                                                                                                                      | #5417, #4884 |
| datahub         | the planned third FTS5 BM25 place uses the keyword retrievers; its staff search fusion uses `RankFusion` or `ScoreFusion`                                                                                                                                       | #3451, #3426 |
| Meddit          | its evidence layer moves onto the package after it ships: PubMed's Best Match gives ranked passages, and its federation's max merge is `ScoreFusion` with `none()` and `max()`                                                                                  | #5378, #5585 |
| `@zukhruf/mteb` | its hybrid search (`fuseRrf`, rsf, dbsf) moves onto `RankFusion`, `ScoreFusion` and `sum()` over ids after this release; MTEB's own edge values stay in its host normalizers                                                                                    | #5400        |

## The same concepts in other systems

| Concept                                                 | Other systems                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Passage`                                               | LlamaIndex `TextNode` ([schema.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/schema.py)); LangChain `Document` ([document.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-core/src/documents/document.ts)); Haystack `Document` ([document.py](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/dataclasses/document.py))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `RankedPassage`, `ScoredPassage`                        | MongoDB's "Ranked Pipeline" of `$rankFusion` and the `$score` that `$scoreFusion` requires ([$rankFusion](https://www.mongodb.com/docs/manual/reference/operator/aggregation/rankFusion/), [$scoreFusion](https://www.mongodb.com/docs/manual/reference/operator/aggregation/scoreFusion/)); Lucene `ScoreDoc`; LlamaIndex `NodeWithScore`; .NET `VectorSearchResult<TRecord>{Record, Score}` ([vector search](https://learn.microsoft.com/en-us/dotnet/ai/vector-stores/vector-search))                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Retriever.retrieve`                                    | LlamaIndex `BaseRetriever.retrieve` ([base_retriever.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/base/base_retriever.py)); LangChain `BaseRetriever` ([retrievers/index.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-core/src/retrievers/index.ts)); Semantic Kernel `ITextSearch` ([text search](https://learn.microsoft.com/en-us/semantic-kernel/concepts/text-search/text-search-abstractions))                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `QueryBundle`, `QueryType`                              | LlamaIndex `QueryBundle` and `QueryType` (LlamaIndex.TS `@llamaindex/core` 0.6.22, `query-engine/dist/index.d.ts`; [schema.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/schema.py))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `keywords`                                              | .NET `HybridSearchAsync(searchValue, keywords)` ([IKeywordHybridSearchable.cs](https://raw.githubusercontent.com/dotnet/extensions/main/src/Libraries/Microsoft.Extensions.VectorData.Abstractions/IKeywordHybridSearchable.cs))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `customEmbeddings`                                      | LlamaIndex.TS `QueryBundle.customEmbeddings`; LlamaIndex `custom_embedding_strs`, whose mean the vector retriever searches ([schema.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/schema.py))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| engine retrievers                                       | Haystack's retrievers for each document store ([retrievers](https://docs.haystack.deepset.ai/docs/retrievers))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| passage store as the root                               | Haystack `PgvectorEmbeddingRetriever(document_store=...)` and `PgvectorKeywordRetriever(document_store=...)` over `PgvectorDocumentStore(schema_name, table_name, language)` ([embedding_retriever.py](https://raw.githubusercontent.com/deepset-ai/haystack-core-integrations/main/integrations/pgvector/src/haystack_integrations/components/retrievers/pgvector/embedding_retriever.py)); LlamaIndex `VectorStoreIndex.as_retriever()`; LangChain `VectorStore.asRetriever()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `topK`, `includeVectors`                                | Haystack `top_k` = 10 ([document_store.py](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/document_stores/in_memory/document_store.py)), `return_embedding`; Mastra `topK` = 10 ([pg](https://mastra.ai/reference/vectors/pg)); .NET `IncludeVectors` ([VectorSearchOptions](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.vectordata.vectorsearchoptions-1))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Filter`                                                | Haystack filters ([metadata filtering](https://docs.haystack.deepset.ai/docs/metadata-filtering)); LlamaIndex `MetadataFilters` ([types.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/vector_stores/types.py)); Qdrant `filter` ([search](https://qdrant.tech/documentation/search/search/))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `FusionRetriever`                                       | LlamaIndex `QueryFusionRetriever` ([fusion_retriever.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/retrievers/fusion_retriever.py)); LangChain `EnsembleRetriever` ([ensemble.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-classic/src/retrievers/ensemble.ts)); Elasticsearch `rrf` ([rrf retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/rrf-retriever)); Qdrant `prefetch` ([hybrid queries](https://qdrant.tech/documentation/concepts/hybrid-queries/))                                                                                                                                                                                                                                                                                                                                                            |
| `RankFusion`, `ScoreFusion`, `FusionInput`              | MongoDB `$rankFusion` and `$scoreFusion`, each input pipeline by name with its weight ([$rankFusion](https://www.mongodb.com/docs/manual/reference/operator/aggregation/rankFusion/), [$scoreFusion](https://www.mongodb.com/docs/manual/reference/operator/aggregation/scoreFusion/)); Elasticsearch `rrf` and `linear` retrievers, `retrievers: [{ retriever, weight }]` ([rrf](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/rrf-retriever), [linear](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/linear-retriever)); OpenSearch normalization processor, a normalization and a combination ([normalization processor](https://docs.opensearch.org/latest/search-plugins/search-pipelines/normalization-processor/)); Qdrant `rrf` and `dbsf` ([hybrid queries](https://qdrant.tech/documentation/concepts/hybrid-queries/)); ranx `fuse` ([fusion](https://amenra.github.io/ranx/fusion/)) |
| `minMax`, `distributionBased`, `none`, `reciprocalRank` | Elasticsearch linear `normalizer` `minmax`, `l2_norm`, `none` ([linear](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/linear-retriever)); OpenSearch `min_max`, `l2`, `z_score` and the `rrf` technique ([normalization processor](https://docs.opensearch.org/latest/search-plugins/search-pipelines/normalization-processor/)); MongoDB `minMaxScaler`, `sigmoid`, `none`; Weaviate `relativeScoreFusion` ([hybrid](https://docs.weaviate.io/weaviate/search/hybrid)); Qdrant `dbsf`; Haystack `distribution_based_rank_fusion` ([document_joiner.py](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/components/joiners/document_joiner.py)); Vespa `reciprocal_rank` ([phased ranking](https://docs.vespa.ai/en/ranking/phased-ranking.html))                                                                                                                                                       |
| `sum`, `max`, `arithmeticMean`                          | OpenSearch `arithmetic_mean`, `geometric_mean`, `harmonic_mean` ([normalization processor](https://docs.opensearch.org/latest/search-plugins/search-pipelines/normalization-processor/)); MongoDB `combination.method` `avg`; Milvus `sum`, `max`, `avg` ([multi-vector search](https://milvus.io/docs/multi-vector-search.md)); ranx `comb_sum`, `comb_max` ([fusion](https://amenra.github.io/ranx/fusion/)); the greatest score of an id: LlamaIndex `QueryFusionRetriever` `simple` mode, Haystack `DocumentJoiner` `concatenate`                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MultiQueryRetriever`, HyDE                             | LangChain `MultiQueryRetriever` ([multi_query.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-classic/src/retrievers/multi_query.ts)), `HydeRetriever` ([HyDE](https://docs.langchain.com/oss/javascript/integrations/retrievers/hyde))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `scoreThreshold`                                        | Qdrant `score_threshold` of a search ([search](https://qdrant.tech/documentation/search/search/)); Elasticsearch knn retriever `similarity` ([knn retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/knn-retriever)); LangChain `similarity_score_threshold` with `score_threshold` ([base.py](https://raw.githubusercontent.com/langchain-ai/langchain/master/libs/core/langchain_core/vectorstores/base.py)); Haystack rankers `score_threshold` ([sentence_transformers_similarity.py](https://github.com/deepset-ai/haystack-core-integrations/blob/main/integrations/sentence_transformers/src/haystack_integrations/components/rankers/sentence_transformers/sentence_transformers_similarity.py))                                                                                                                                                                                                              |
| `RerankRetriever`                                       | Elasticsearch `text_similarity_reranker` around a child retriever ([text similarity reranker](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/text-similarity-reranker-retriever)); LangChain `ContextualCompressionRetriever` with `CohereRerank` as its `baseCompressor` ([contextual_compression.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-classic/src/retrievers/contextual_compression.ts))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `EmbeddingRerankRetriever`                              | LangChain `EmbeddingsFilter` as the `baseCompressor` of a `ContextualCompressionRetriever` ([embeddings_filter.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-classic/src/retrievers/document_compressors/embeddings_filter.ts)); LlamaIndex `SentenceEmbeddingOptimizer`, which embeds the sentences of each node ([optimizer.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/postprocessor/optimizer.py)); Haystack `SentenceTransformersDiversityRanker`, which embeds the documents itself ([sentence_transformers_diversity.py](https://github.com/deepset-ai/haystack-core-integrations/blob/main/integrations/sentence_transformers/src/haystack_integrations/components/rankers/sentence_transformers/sentence_transformers_diversity.py))                                                                                                              |
| `PostprocessingRetriever`                               | LangChain `ContextualCompressionRetriever` ([contextual_compression.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-classic/src/retrievers/contextual_compression.ts)); LlamaIndex `node_postprocessors` ([types.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/postprocessor/types.py))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `MaximalMarginalRelevance`                              | Elasticsearch `diversify` `lambda` ([diversify retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/diversify-retriever)); Weaviate `balance` ([1.39](https://weaviate.io/blog/weaviate-1-39-release)); Qdrant `mmr` `diversity`, 1 = diverse ([search relevance](https://qdrant.tech/documentation/search/search-relevance/))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `rankWindowSize`                                        | Elasticsearch `rank_window_size` of the `text_similarity_reranker`, `diversify`, `rrf` and `linear` retrievers, at least `size` ([text similarity reranker](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/text-similarity-reranker-retriever), [diversify retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/diversify-retriever)); Elasticsearch and OpenSearch rescore `window_size`; Vespa `rerank-count` ([phased ranking](https://docs.vespa.ai/en/ranking/phased-ranking.html))                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Collapse`                                              | Elasticsearch `collapse` ([standard retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/standard-retriever)); Vespa `collapsesize` ([query API](https://docs.vespa.ai/en/reference/api/query.html)); Qdrant `query_points_groups` ([search](https://qdrant.tech/documentation/search/search/))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `ContextWindow`                                         | Haystack `SentenceWindowRetriever` ([sentence_window_retriever.py](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/components/retrievers/sentence_window_retriever.py)); LlamaIndex `PrevNextNodePostprocessor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `LongContextReorder`                                    | LangChain `LongContextReorder` ([reference](https://reference.langchain.com/python/langchain-community/document_transformers/long_context_reorder/LongContextReorder)); Haystack `LostInTheMiddleRanker` ([rankers](https://docs.haystack.deepset.ai/docs/rankers))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| hybrid search in SQL                                    | Alex Garcia's sqlite-vec recipe, RRF k 60 in SQL ([hybrid search](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| passage contract                                        | pgai `create_vectorizer` ([API reference](https://raw.githubusercontent.com/timescale/pgai/main/docs/vectorizer/api-reference.md)); Airbyte pgvector ([destination](https://docs.airbyte.com/integrations/destinations/pgvector))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Why not an npm package

Checked on 2026-11-23 with `npm pack` of each candidate and no install. The requirements: **R1** takes AI SDK 7 models; **R2** reads tables that exist, on SQLite, Postgres and SQL Server; **R3** has the features (fusion, rerank, MMR, grouping); **R4** takes an `AbortSignal`. No candidate passes all four. R2 decides: every store creates its own tables, and none searches vectors in SQL Server. Node 26.13.0 has no built-in module for retrieval, reranking, BM25 or fusion.

| Package                                | R1                                                                | R2                                                                                              | R3                                                                                    | R4                                |
| -------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------- |
| `llamaindex` 0.12.1                    | fails: only `@llamaindex/vercel`, peer `ai` ^5                    | fails: `@llamaindex/postgres` creates fixed columns; no `node:sqlite` or SQL Server store       | in part: HYBRID and MMR modes, a cutoff, a reranker; no RRF                           | fails: `retrieve` takes no signal |
| `@langchain/core`, `/classic`          | fails: no `ai` import                                             | in part: `PGVectorStore` maps a table, with metadata in one JSONB column; no SQL Server store   | in part: RRF `c` 60, multi-query, HyDE, compression, MMR; no score fusion or collapse | passes: `RunnableConfig.signal`   |
| `@mastra/rag` 2.8.1                    | in part: own model types; `rerank` is not AI SDK `RerankingModel` | fails: `@mastra/pg` and `@mastra/libsql` create their tables; `@mastra/mssql` has no vector API | fails: no RRF or MMR                                                                  | fails: no `AbortSignal`           |
| `@orama/orama` 3.1.18                  | fails: own embedding plugins                                      | fails: an in-memory index of its own, no SQL                                                    | in part: a hybrid mode                                                                | fails: no `AbortSignal`           |
| `@convex-dev/rag` 0.7.9                | passes: peer `ai` ^7                                              | fails: it chunks and embeds into Convex storage                                                 | in part: RRF, filters, neighbour chunks; no rerank or MMR                             | fails: no `AbortSignal`           |
| `@reaatech/hybrid-rag-retrieval` 0.1.1 | fails: depends on `openai`, no `ai` import                        | fails: depends on Qdrant                                                                        | in part: RRF, own BM25, a reranker                                                    | fails: no signal                  |

## API

```ts
// @zukhruf/retrieval
import type { EmbeddingModel, LanguageModel, RerankingModel } from 'ai';

type Metadata = Readonly<Record<string, unknown>>; // the host's own fields
type Passage<M extends Metadata = Metadata> = {
  readonly id: string;
  readonly text: string;
  readonly metadata: M;
};
type StoredPassage<M extends Metadata = Metadata> = Passage<M> & {
  readonly source: string; // the key of the row or file that the passage comes from
  readonly seq: number; // the position of the passage in its source
  readonly start: number; // offsets in code points, end exclusive (ADR 0001)
  readonly end: number;
}; // the engine retrievers and the passage stores give it (ADR 0015)
// A list is best first; the place of a passage is its rank (ADR 0021).
type RankedPassage<P extends Passage = Passage> = {
  readonly passage: P;
  readonly vector?: readonly number[];
}; // an order only, such as a web search
type ScoredPassage<P extends Passage = Passage> = RankedPassage<P> & {
  readonly score: number; // finite, higher is better (ADR 0005)
}; // a scored passage is a ranked passage
type RetrievalResult<
  P extends Passage = Passage,
  I extends RankedPassage<P> = RankedPassage<P>, // the item of the list
> = {
  readonly passages: readonly I[]; // best first
  readonly failures: ReadonlyMap<string, RetrieverUnavailableError>; // by name; empty when none failed (ADR 0014)
};

// The stored fields of P and metadata.<key> of its metadata, with their types.
type FilterFields<P extends Passage> = {
  readonly [F in keyof P & ('source' | 'seq' | 'start' | 'end')]: P[F];
} & {
  readonly [
    K in keyof P['metadata'] & string as `metadata.${K}`
  ]: P['metadata'][K];
};
type Filter<P extends Passage = Passage> =
  | {
      readonly operator: 'AND' | 'OR' | 'NOT';
      readonly conditions: readonly Filter<P>[];
    }
  | {
      // for each field F of FilterFields<P>:
      readonly field: F;
      readonly operator: '==' | '!=' | '>' | '>=' | '<' | '<=';
      readonly value: FilterFields<P>[F] | null;
    }
  | {
      readonly field: F;
      readonly operator: 'in' | 'not in';
      readonly value: readonly FilterFields<P>[F][];
    };

type RetrieveOptions<P extends Passage = Passage> = {
  readonly topK?: number; // 10
  readonly filter?: Filter<P>;
  readonly includeVectors?: boolean; // false
  readonly signal?: AbortSignal; // rejects with its reason when it aborts
};

type QueryBundle = {
  readonly query: string; // the information need
  readonly keywords?: readonly [string, ...string[]]; // each one phrase; the words of query when absent
  readonly customEmbeddings?: readonly [string, ...string[]]; // [query] when absent; the mean of their vectors; a blank text is a RangeError
};
type QueryType = string | QueryBundle; // a string is { query }

interface Retriever<
  in Q extends QueryType = QueryType,
  P extends Passage = Passage,
  out I extends RankedPassage<P> = RankedPassage<P>, // RankedPassage<P> or ScoredPassage<P>
> {
  readonly retrieve: (
    query: Q,
    options?: RetrieveOptions<P>,
  ) => Promise<RetrievalResult<P, I>>;
} // a scored retriever is a ranked one; a ranked retriever is not a scored one
interface BatchRetriever<
  P extends Passage = Passage,
  I extends RankedPassage<P> = RankedPassage<P>,
> extends Retriever<QueryType, P, I> {
  readonly retrieveMany: (
    queries: readonly QueryType[],
    options?: RetrieveOptions<P>,
  ) => Promise<RetrievalResult<P, I>[]>; // one for each query, in their order
}

// A fusion fuses ids (ADR 0020). The ports are generic in their parameter
// only, not in their member (the island rule): a host's fusion, strategy or
// postprocessor is written for its own types with no assertion.
type RankedDoc = { readonly id: string }; // its place in the list is its rank
type ScoreDoc = RankedDoc & { readonly score: number }; // Lucene ScoreDoc
type FusionInput<D extends RankedDoc> = {
  readonly name: string; // every error names it
  readonly docs: readonly D[]; // best first
  readonly weight: number; // finite and 0 or more; at least one input above 0
};
interface Fusion<in D extends RankedDoc> {
  readonly fuse: (inputs: readonly FusionInput<D>[]) => ScoreDoc[]; // best first; a tie keeps the order of first appearance
} // a Fusion<RankedDoc> is a Fusion<ScoreDoc>

interface ListScores {
  readonly min: number;
  readonly max: number;
  readonly mean: number;
  readonly std: number; // population (ddof 0)
  readonly l2: number; // sqrt(Σ s²)
} // each computed on its first read, in the order of the list
interface ScoreNormalizer {
  readonly normalize: (score: number, list: ListScores) => number;
}
interface RankNormalizer {
  readonly normalize: (rank: number, length: number) => number; // rank from 1
}
interface Combination {
  readonly combine: (
    contributions: readonly {
      readonly score: number;
      readonly weight: number;
    }[], // the inputs that hold the id, in input order
  ) => number;
}
function reciprocalRank(options?: { readonly k?: number }): RankNormalizer; // 1 / (k + rank); k 60, an integer of 1 or more
function minMax(): ScoreNormalizer; // (s - min) / (max - min); 1 when all are equal
function distributionBased(): ScoreNormalizer; // mean ± 3σ, not clipped; 0.5 when σ is 0
function none(): ScoreNormalizer; // s
function sum(): Combination; // Σ w·s
function max(): Combination; // the greatest w·s
function arithmeticMean(): Combination; // Σ w·s / Σ w; 0 when Σ w is 0

// A normalized or a combined score that is not finite is a TypeError.
class RankFusion implements Fusion<RankedDoc> {
  constructor(options?: {
    readonly normalizer?: RankNormalizer; // reciprocalRank({ k: 60 })
    readonly combination?: Combination; // sum()
  }); // reads no score
}
class ScoreFusion implements Fusion<ScoreDoc> {
  constructor(options: {
    readonly normalizer: ScoreNormalizer;
    readonly combination: Combination;
  }); // an input score that is not finite is a TypeError
}

class FusionRetriever<
  in Q extends QueryType = QueryType,
  in out P extends Passage = Passage,
  F = unknown, // the fields of a doc besides its id: unknown under a RankFusion, { score: number } under a ScoreFusion
  K extends string = string, // the names of the retrievers
> implements Retriever<Q, P, ScoredPassage<P>> {
  constructor(options: {
    readonly retrievers: Readonly<
      Record<
        K,
        {
          readonly retriever: Retriever<Q, P, RankedPassage<P> & F>; // each gets the query unchanged
          readonly weight?: number; // 1; finite and 0 or more, at least one above 0
        }
      >
    >; // at least one; no name holds ':'; the lists fuse in the order of the names
    readonly fusion?: Fusion<RankedDoc & F>; // new RankFusion()
    readonly rankWindowSize?: number; // the topK of the call; a positive integer, at least that topK
  }); // an unavailable retriever is named in failures, 'outer:inner' when nested; none answered: NoRetrieverAnsweredError; a bug aborts the others and rejects; the caller's abort rejects at once
}
class MultiQueryRetriever<
  in out P extends Passage = Passage,
  F = unknown, // as for FusionRetriever
> implements Retriever<QueryType, P, ScoredPassage<P>> {
  constructor(options: {
    readonly retriever: Retriever<QueryType, P, RankedPassage<P> & F>; // gets the query, then each version as a string
    readonly model: LanguageModel;
    readonly queryCount?: number; // 4 versions, besides the query
    readonly fusion?: Fusion<RankedDoc & F>; // new RankFusion(); inputs 'query', 'version 1' … with weight 1
  }); // the failures of the searches merge by name, the first kept; an error of a search aborts the others and rejects; the caller's abort rejects at once
}
class HydeRetriever<
  in out P extends Passage = Passage,
  out I extends RankedPassage<P> = RankedPassage<P>, // the kind of its retriever
> implements Retriever<QueryType, P, I> {
  constructor(options: {
    readonly retriever: Retriever<QueryBundle, P, I>; // gets the query bundle with customEmbeddings: [passage]; its failures pass up
    readonly model: LanguageModel;
  });
}
class RerankRetriever<
  in Q extends QueryType = QueryType,
  in out P extends Passage = Passage,
> implements Retriever<Q, P, ScoredPassage<P>> {
  constructor(options: {
    readonly retriever: Retriever<Q, P>; // any kind; gets the window as its topK; its failures pass up
    readonly model: RerankingModel;
    readonly rankWindowSize?: number; // the topK of the call; a positive integer, at least that topK
    readonly topN?: number; // a positive integer, or a RangeError; every passage when absent
    readonly scoreThreshold?: number; // keeps a relevance >= it; not finite is a RangeError
  }); // the relevance of the model is the score, best first, cut to the topK of the call; a relevance that is not finite is a TypeError
}
class EmbeddingRerankRetriever<
  in Q extends QueryType = QueryType,
  in out P extends Passage = Passage,
> implements Retriever<Q, P, ScoredPassage<P>> {
  constructor(options: {
    readonly retriever: Retriever<Q, P>; // any kind; gets the window as its topK; its failures pass up
    readonly model: EmbeddingModel; // embeds the query of the bundle and the text of each passage
    readonly rankWindowSize?: number; // the topK of the call; a positive integer, at least that topK
    readonly topN?: number; // a positive integer, or a RangeError; every passage when absent
    readonly scoreThreshold?: number; // keeps a cosine similarity >= it; not finite is a RangeError
  }); // the cosine similarity is the score, best first, with the vector the model made when the call asks with includeVectors, cut to the topK of the call; a blank information need is a RangeError; a cosine that is not finite is a TypeError
}

interface Postprocessor<
  in out P extends Passage = Passage,
  in out I extends RankedPassage<P> = RankedPassage<P>, // the kind it takes and gives
> {
  readonly postprocess: (
    passages: readonly I[],
    query: string, // the query of the query bundle
    options?: { readonly signal?: AbortSignal },
  ) => Promise<I[]>;
}
class PostprocessingRetriever<
  in Q extends QueryType = QueryType,
  in out P extends Passage = Passage,
  in out I extends RankedPassage<P> = RankedPassage<P>,
> implements Retriever<Q, P, I> {
  constructor(
    options:
      | {
          readonly retriever: Retriever<Q, P, I>; // gets the topK of the call; its failures pass up
          readonly postprocessors: readonly Postprocessor<
            NoInfer<P>,
            NoInfer<I>
          >[]; // P and I come from the retriever
        }
      | {
          readonly retriever: Retriever<Q, P, I>; // gets the window as its topK
          readonly postprocessors: readonly [
            Postprocessor<NoInfer<P>, NoInfer<I>>,
            ...Postprocessor<NoInfer<P>, NoInfer<I>>[],
          ]; // at least one: they run on the window
          readonly rankWindowSize: number; // a positive integer, at least the topK of the call
        },
  ); // gives the first topK of the last postprocessor
}
// Each built-in keeps the kind it gets: postprocess<I extends RankedPassage>(…):
// Promise<I[]>, ContextWindow<M> postprocess<I extends RankedPassage<StoredPassage<M>>>(…),
// and Collapse<P, F> postprocess<I extends RankedPassage<P>>(…) of passages that have F.
class MaximalMarginalRelevance implements Postprocessor<Passage> {
  constructor(options: {
    readonly model: EmbeddingModel; // the model of the passage vectors; it embeds the query
    readonly lambda?: number; // 0.5; 1 = relevance only
    readonly topK: number;
  });
}
class Collapse<
  P extends Passage = StoredPassage,
  F extends keyof FilterFields<P> = keyof FilterFields<P>, // the field as written
> {
  // A stored passage type: options?, field 'source' when absent. A live one:
  // options with the field, since its passages have no source. Keeps the
  // first size passages of each value, in the order of the list; reads no
  // score.
  constructor(options?: {
    readonly field?: F; // a field of P, as in a filter
    readonly size?: number; // 1
  });
  // Only passages that have F, of either kind.
  postprocess<I extends RankedPassage<P>>(
    passages: readonly I[] &
      (F extends keyof FilterFields<I['passage']> ? unknown : never),
  ): Promise<I[]>;
}
class LongContextReorder implements Postprocessor<Passage> {}
class ContextWindow<M extends Metadata = Metadata> implements Postprocessor<
  StoredPassage<M>
> {
  constructor(options: {
    readonly store: PassageStore<M>; // M comes from the store
    readonly windowSize?: number; // 3
  });
}

interface PassageStore<M extends Metadata = Metadata> {
  get(
    ids: readonly string[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<ReadonlyMap<string, StoredPassage<M>>>;
  neighbours(options: {
    readonly source: string;
    readonly seq: number;
    readonly windowSize: number;
    readonly signal?: AbortSignal;
  }): Promise<StoredPassage<M>[]>;
}

class ModelMismatchError extends Error {
  readonly name: 'ModelMismatchError';
  readonly stored: { readonly provider: string; readonly modelId: string };
  readonly query: { readonly provider: string; readonly modelId: string };
}
class VectorMissingError extends Error {
  readonly name: 'VectorMissingError';
  readonly passageId: string;
}
class PassageGapError extends Error {
  readonly name: 'PassageGapError';
  readonly source: string;
  readonly start: number; // the end of the passages before the gap
  readonly end: number; // the start of the passage after it
}
// A host adapter throws it, or a subclass, when its source cannot answer (ADR 0014).
class RetrieverUnavailableError extends Error {
  readonly name: string; // 'RetrieverUnavailableError'
}
class NoRetrieverAnsweredError extends RetrieverUnavailableError {
  readonly name: 'NoRetrieverAnsweredError';
  readonly failures: ReadonlyMap<string, RetrieverUnavailableError>; // cause: an AggregateError of them
  constructor(failures: ReadonlyMap<string, RetrieverUnavailableError>);
}

// @zukhruf/retrieval/sqlite
class SqlitePassageStore<
  M extends Metadata = Metadata,
> implements PassageStore<M> {
  constructor(options: {
    readonly database: DatabaseSync; // node:sqlite
    readonly passages: string;
    readonly metadata: (columns: Metadata) => M; // the other columns of a row; (columns) => columns keeps them
  });
}
class SqliteEmbeddingRetriever<
  in out M extends Metadata = Metadata,
> implements BatchRetriever<StoredPassage<M>, ScoredPassage<StoredPassage<M>>> {
  constructor(options: {
    readonly store: SqlitePassageStore<M>;
    readonly vectors: string;
    readonly model: EmbeddingModel;
    readonly scoreThreshold?: number; // keeps a score >= it, from -1 to 1; not finite is a RangeError
  });
}
type SqliteMatching =
  | { readonly operator: 'OR'; readonly cutoffFrequency?: number } // a count, or a share under 1
  | { readonly operator: 'AND' };
class SqliteBM25Retriever<
  in out M extends Metadata = Metadata,
> implements Retriever<
  QueryType,
  StoredPassage<M>,
  ScoredPassage<StoredPassage<M>>
> {
  constructor(options: {
    readonly store: SqlitePassageStore<M>;
    readonly index: string; // the FTS5 table
    readonly matching?: SqliteMatching; // { operator: 'OR', cutoffFrequency: 20_000 }
  });
}

// @zukhruf/retrieval/postgres
type PostgresSession = {
  query(
    sql: string,
    parameters: readonly unknown[], // $1 for the first
    options?: { readonly signal?: AbortSignal }, // cancel the query when it aborts
  ): Promise<readonly Record<string, unknown>[]>;
};
class PostgresPassageStore<
  M extends Metadata = Metadata,
> implements PassageStore<M> {
  constructor(options: {
    readonly session: PostgresSession;
    readonly schema?: string; // the search_path of the session when absent
    readonly passages: string;
    readonly metadata: (columns: Metadata) => M; // the other columns of a row; (columns) => columns keeps them
  });
}
class PgvectorEmbeddingRetriever<
  in out M extends Metadata = Metadata,
> implements BatchRetriever<StoredPassage<M>, ScoredPassage<StoredPassage<M>>> {
  constructor(options: {
    readonly store: PostgresPassageStore<M>;
    readonly vectors: string;
    readonly model: EmbeddingModel;
    readonly scoreThreshold?: number; // keeps a score >= it, from -1 to 1; not finite is a RangeError
  });
}
type PostgresMatching =
  // no OR on Postgres
  | { readonly strategy: 'frequency'; readonly dropTokensThreshold?: number }
  | { readonly strategy: 'all' };
class PgvectorKeywordRetriever<
  in out M extends Metadata = Metadata,
> implements Retriever<
  QueryType,
  StoredPassage<M>,
  ScoredPassage<StoredPassage<M>>
> {
  constructor(options: {
    readonly store: PostgresPassageStore<M>;
    readonly index: {
      readonly column: string; // the tsvector column of the passages
      readonly configuration?: string; // 'english'
    };
    readonly matching?: PostgresMatching; // { strategy: 'frequency', dropTokensThreshold: 10 }
  });
}

// @zukhruf/retrieval/sqlserver
type SqlServerSession = {
  query(
    sql: string,
    parameters: Readonly<Record<string, unknown>>, // @p0 for the key p0
    options?: { readonly signal?: AbortSignal }, // cancel the query when it aborts
  ): Promise<readonly Record<string, unknown>[]>;
};
class SqlServerPassageStore<
  M extends Metadata = Metadata,
> implements PassageStore<M> {
  constructor(options: {
    readonly session: SqlServerSession;
    readonly schema?: string; // the default schema of the user when absent
    readonly passages: string;
    readonly metadata: (columns: Metadata) => M; // the other columns of a row; (columns) => columns keeps them
  });
}
class SqlServerEmbeddingRetriever<
  in out M extends Metadata = Metadata,
> implements BatchRetriever<StoredPassage<M>, ScoredPassage<StoredPassage<M>>> {
  constructor(options: {
    readonly store: SqlServerPassageStore<M>;
    readonly vectors: string;
    readonly model: EmbeddingModel;
    readonly scoreThreshold?: number; // keeps a score >= it, from -1 to 1; not finite is a RangeError
  });
}
type SqlServerMatching =
  | { readonly predicate: 'FREETEXT' }
  | { readonly predicate: 'CONTAINS'; readonly operator: 'AND' | 'OR' };
class SqlServerKeywordRetriever<
  in out M extends Metadata = Metadata,
> implements Retriever<
  QueryType,
  StoredPassage<M>,
  ScoredPassage<StoredPassage<M>>
> {
  constructor(options: {
    readonly store: SqlServerPassageStore<M>;
    readonly index: { readonly table: string }; // the base table with the full-text index on [text]
    readonly matching?: SqlServerMatching; // { predicate: 'FREETEXT' }
  });
}
```

## Documentation

**Recipes**

- [Search with an instruction-tuned embedding model](./docs/recipes/search-with-an-instruction-tuned-model.md)

**Decisions**

- [ADR 0001](./docs/adr/0001-the-package-is-the-query-side-of-rag-and-reads-a-passage-contract-that-elt-writes.md): the package is the query side of RAG and reads a passage contract that elt writes (superseded in part by ADR 0015 and ADR 0022).
- [ADR 0002](./docs/adr/0002-a-retriever-is-a-port-for-any-source.md): a retriever is a port for any source (superseded in part by ADR 0013, ADR 0014, ADR 0015 and ADR 0021).
- [ADR 0003](./docs/adr/0003-an-embedding-retriever-runs-the-vector-search-in-the-sql-of-its-engine-one-query-or-a-batch.md): an embedding retriever runs the vector search in the SQL of its engine, one query or a batch (superseded in part by ADR 0013 and ADR 0014).
- [ADR 0004](./docs/adr/0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md): a keyword retriever queries the keyword index that elt writes (superseded in part by ADR 0013 and ADR 0018).
- [ADR 0005](./docs/adr/0005-a-score-is-higher-for-a-better-passage.md): a score is higher for a better passage (superseded in part by ADR 0016, ADR 0019 and ADR 0021).
- [ADR 0006](./docs/adr/0006-a-retriever-gives-10-passages-when-the-caller-gives-no-topk.md): a retriever gives 10 passages when the caller gives no topK.
- [ADR 0007](./docs/adr/0007-reciprocal-rank-fusion-is-the-default-fusion-with-k-60-and-ranks-from-1.md): reciprocal rank fusion is the default fusion, with k 60 and ranks from 1 (superseded in part by ADR 0014, ADR 0016, ADR 0020 and ADR 0023).
- [ADR 0008](./docs/adr/0008-a-search-is-composed-of-retrievers-that-wrap-retrievers-and-a-list-of-postprocessors.md): a search is composed of retrievers that wrap retrievers and a list of postprocessors (superseded in part by ADR 0013, ADR 0014, ADR 0016, ADR 0017, ADR 0019, ADR 0020, ADR 0021 and ADR 0023).
- [ADR 0009](./docs/adr/0009-a-filter-has-the-shape-of-haystacks-filters.md): a filter has the shape of Haystack's filters (superseded in part by ADR 0015).
- [ADR 0010](./docs/adr/0010-an-embedding-retriever-refuses-a-query-model-whose-identity-differs-from-the-stored-vectors.md): an embedding retriever refuses a query model whose identity differs from the stored vectors.
- [ADR 0011](./docs/adr/0011-the-package-is-in-the-base-layer.md): the package is in the base layer (superseded in part by ADR 0020).
- [ADR 0012](./docs/adr/0012-the-package-is-zukhruf-retrieval-and-its-port-is-retriever-with-retrieve-after-go.md): the package is @zukhruf/retrieval, and its port is Retriever with retrieve, after Go.
- [ADR 0013](./docs/adr/0013-a-query-is-a-string-or-a-query-bundle-with-a-text-for-each-kind-of-search.md): a query is a string or a query bundle, with a text for each kind of search (superseded in part by ADR 0015, ADR 0018, ADR 0020 and ADR 0021).
- [ADR 0014](./docs/adr/0014-a-retrieve-call-answers-with-the-retrievers-that-answered-and-names-those-that-were-unavailable.md): a retrieve call answers with the retrievers that answered and names those that were unavailable (superseded in part by ADR 0020).
- [ADR 0015](./docs/adr/0015-a-passage-is-typed-by-its-metadata-and-only-a-stored-passage-has-source-seq-start-and-end.md): a passage is typed by its metadata, and only a stored passage has source, seq, start and end (superseded in part by ADR 0020 and ADR 0021).
- [ADR 0016](./docs/adr/0016-a-scored-passage-may-have-no-score-and-a-list-is-in-the-retrievers-order.md): a scored passage may have no score, and a list is in the retriever's order (superseded by ADR 0021).
- [ADR 0017](./docs/adr/0017-every-async-port-takes-an-optional-abort-signal-and-a-composite-rejects-at-once-when-it-aborts.md): every async port takes an optional abort signal, and a composite rejects at once when it aborts (superseded in part by ADR 0021).
- [ADR 0018](./docs/adr/0018-each-keyword-retriever-matches-in-the-strongest-form-of-its-engine.md): each keyword retriever matches in the strongest form of its engine.
- [ADR 0019](./docs/adr/0019-a-score-threshold-belongs-to-the-embedding-retriever-or-to-rerank-where-the-scale-of-the-score-is-known.md): a score threshold belongs to the embedding retriever or to Rerank, where the scale of the score is known (superseded in part by ADR 0021 and ADR 0022).
- [ADR 0020](./docs/adr/0020-a-fusion-is-a-rank-fusion-or-a-score-fusion-over-ids-with-a-normalizer-for-each-list-and-a-combination.md): a fusion is a rank fusion or a score fusion over ids, with a normalizer for each list and a combination.
- [ADR 0021](./docs/adr/0021-a-retriever-says-whether-it-gives-scores-a-ranked-passage-has-none-and-a-scored-passage-always-has-one.md): a retriever says whether it gives scores: a ranked passage has none, and a scored passage always has one (superseded in part by ADR 0023).
- [ADR 0022](./docs/adr/0022-a-reranker-may-embed-the-text-of-the-candidates-when-the-query-runs.md): a reranker may embed the text of the candidates when the query runs (superseded in part by ADR 0023).
- [ADR 0023](./docs/adr/0023-a-composite-that-fuses-reranks-or-diversifies-asks-its-retriever-for-a-rank-window-and-gives-the-topk-of-the-call.md): a composite that fuses, reranks or diversifies asks its retriever for a rank window and gives the topK of the call.
