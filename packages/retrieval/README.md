# @zukhruf/retrieval

> Design on paper, for review: no code exists yet. Ezz approved the API on 2026-11-23 ("Approve, write the paper"). He ruled on each ADR the same day; all are accepted (backlog #5399). Each example below shows the planned API.

This package is the query side of retrieval-augmented generation (RAG). A query goes in. The best passages come out, best first, each with a score that is higher for a better passage. The package never cuts or embeds documents: elt writes the passages, their vectors with the model identity, and a keyword index ([ADR 0001](./docs/adr/0001-the-package-is-the-query-side-of-rag-and-reads-a-passage-contract-that-elt-writes.md)).

The port of the package is `Retriever`. The engine retrievers read that passage contract with the SQL of SQLite, Postgres or SQL Server. A host can implement `Retriever` over any other source, such as a web search. Composite retrievers fuse retrievers or rewrite the query, and postprocessors rerank, cut, diversify, group, reorder and widen the result.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/retrieval @zukhruf/vectors ai @ai-sdk/openai
```

```ts
// Planned API.
import { DatabaseSync } from 'node:sqlite';

import { openai } from '@ai-sdk/openai';

import {
  SqliteEmbeddingRetriever,
  SqlitePassageStore,
} from '@zukhruf/retrieval/sqlite';
import { install } from '@zukhruf/vectors/sqlite';

const database = new DatabaseSync('knowledge.db'); // elt wrote the passage contract here
install(database); // or load sqlite-vec: the SQL is the same

const store = new SqlitePassageStore({ database, passages: 'docs_passages' });
const retriever = new SqliteEmbeddingRetriever({
  store,
  vectors: 'docs_passage_vectors',
  model: openai.embedding('text-embedding-3-small'),
});

const results = await retriever.retrieve('how do I rotate a key?');
// 10 scored passages, best first: { passage: { id, text, source, seq, start, end, metadata }, score }
```

The passage store is the root of the composition. It holds the connection and the passages, and on Postgres and SQL Server the schema of the contract. Each retriever and `ContextWindow` takes the store and only its own part: the vectors and the model, or the keyword index. So two retrievers of one search read one connection and one contract, as Haystack's retrievers take their `document_store`.

## Search passages by meaning

An embedding retriever embeds the query with its AI SDK model and sends one SQL query to the engine. The engine ranks the passages by cosine similarity: `vec_distance_cosine` on SQLite, pgvector's `<=>` on Postgres, `VECTOR_DISTANCE` on SQL Server ([ADR 0003](./docs/adr/0003-an-embedding-retriever-runs-the-vector-search-in-the-sql-of-its-engine-one-query-or-a-batch.md)). The score is `1 - cosine distance`.

```ts
// Planned API.
import {
  PgvectorEmbeddingRetriever,
  PostgresPassageStore,
} from '@zukhruf/retrieval/postgres';

const store = new PostgresPassageStore({
  session: {
    query: (sql, parameters) => pool.query(sql, parameters).then((r) => r.rows),
  },
  schema: 'rag', // the search_path of the session finds the relations when absent
  passages: 'docs_passages',
});
const retriever = new PgvectorEmbeddingRetriever({
  store,
  vectors: 'docs_passage_vectors', // rag.docs_passage_vectors
  model,
});

const results = await retriever.retrieve('rotate a key', {
  topK: 5,
  abortSignal,
});
```

The retriever reads the model identity of the stored vectors first. When its query model has another provider or model id, the call fails with `ModelMismatchError` and sends no model call and no search. When the query vector has other dimensions than the stored vectors, the call fails with `DimensionMismatchError` of `@zukhruf/vectors` after the model call and sends no search ([ADR 0010](./docs/adr/0010-an-embedding-retriever-refuses-a-query-model-whose-identity-differs-from-the-stored-vectors.md)).

## Search by keywords

A keyword retriever queries the keyword index that elt writes: FTS5 on SQLite, `tsvector` on Postgres, full-text on SQL Server. It quotes each word of the query, so a word of the user is never an operator of the engine. Its score is higher for a better match on every engine; `SqliteBM25Retriever` negates `bm25()` ([ADR 0004](./docs/adr/0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md)).

```ts
// Planned API.
import { SqliteBM25Retriever } from '@zukhruf/retrieval/sqlite';

const keywords = new SqliteBM25Retriever({
  store,
  index: 'docs_passages_fts',
  operator: 'OR', // the default is 'AND', the implicit operator of FTS5
});

const results = await keywords.retrieve('rotate signing key');
```

On Postgres the query has to use the text search configuration of the index. `PgvectorKeywordRetriever` takes it in the index value, `index: { column, configuration }`, `'english'` when absent, as Haystack's `language`, LlamaIndex's `text_search_config` and LangChain's `tsv_lang` do. The configuration is a parameter of the statement, never SQL.

```ts
// Planned API.
import { PgvectorKeywordRetriever } from '@zukhruf/retrieval/postgres';

const keywords = new PgvectorKeywordRetriever({
  store,
  index: {
    column: 'keywords', // GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED
    configuration: 'simple', // keeps stop words and does not stem
  },
});
```

## Search SQL Server

`@zukhruf/retrieval/sqlserver` needs SQL Server 2025 or Azure SQL for `VECTOR` and `VECTOR_DISTANCE`, and Full-Text Search for the keyword retriever. The session takes named parameters, `@p0` for the key `p0`, as the SQL Server store of `@zukhruf/embedding-cache` does, so the package imports no driver.

```ts
// Planned API.
import mssql from 'mssql';

import {
  SqlServerEmbeddingRetriever,
  SqlServerKeywordRetriever,
  SqlServerPassageStore,
} from '@zukhruf/retrieval/sqlserver';

const pool = await new mssql.ConnectionPool(connectionString).connect();
const store = new SqlServerPassageStore({
  session: {
    async query(sql, parameters) {
      const request = pool.request();
      for (const [name, value] of Object.entries(parameters))
        request.input(name, value);
      return (await request.query(sql)).recordset ?? [];
    },
  },
  schema: 'rag', // the default schema of the user when absent
  passages: 'docs_passages',
});
const meaning = new SqlServerEmbeddingRetriever({
  store,
  vectors: 'docs_passage_vectors', // [rag].[docs_passage_vectors]
  model,
});
const keywords = new SqlServerKeywordRetriever({
  store,
  index: { table: 'docs_passages' }, // the table with the full-text index on [text]
});
```

- **The vector search is exact.** `VECTOR_DISTANCE` reads every vector of the identity of the query; it uses no DiskANN index. The approximate `VECTOR_SEARCH` waits: on SQL Server 2025 it is a preview, filters after the search and needs a read-only table with an INT key ([ADR 0003](./docs/adr/0003-an-embedding-retriever-runs-the-vector-search-in-the-sql-of-its-engine-one-query-or-a-batch.md)).
- **Ids, sources and model identities compare in binary**, `Latin1_General_100_BIN2`, so `A` is not `a` and a tie orders as on SQLite and Postgres, whatever the collation of the database is. A filter compares in the collation of its column, usually case-insensitive.
- **The keyword index is a table.** `CONTAINSTABLE` reads a full-text index of a base table, never of a view, so `index.table` names the table whose full-text key is the passage id; the passages can be a view over it ([ADR 0004](./docs/adr/0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md)). The score is `RANK`, from 0 to 1000.
- **Make the index with `STOPLIST = OFF`.** With the system stoplist, a stop word or a single letter in an `AND` query gives no passages. A word of punctuation only is dropped from the query, because SQL Server reads it as a stop word under every stoplist.
- **A query of more than 4,000 characters of condition fails** with SQL Server's error 4110: the driver binds the text as `NVARCHAR(MAX)`, which `CONTAINSTABLE` refuses.

## Combine searches

`FusionRetriever` asks each retriever for `rankWindowSize` passages, fuses the lists on `Passage.id` and gives the best `topK`. The default fusion is reciprocal rank fusion with k 60 and ranks from 1; each retriever has a weight of 1 ([ADR 0007](./docs/adr/0007-reciprocal-rank-fusion-is-the-default-fusion-with-k-60-and-ranks-from-1.md)).

```ts
// Planned API.
import {
  FusionRetriever,
  MultiQueryRetriever,
  relativeScoreFusion,
} from '@zukhruf/retrieval';

const hybrid = new FusionRetriever({
  retrievers: [meaning, keywords],
  rankWindowSize: 50,
});

const minMax = new FusionRetriever({
  retrievers: [meaning, keywords],
  fusion: relativeScoreFusion(),
  weights: [0.75, 0.25],
});

// The language model writes 4 versions of the query; reciprocalRankFusion() fuses their lists, as in FusionRetriever.
const expanded = new MultiQueryRetriever({
  retriever: hybrid,
  model: languageModel,
});
```

`HydeRetriever { retriever, model }` asks the language model for an answer and searches with that answer as the query.

## Rerank and post-process the results

`PostprocessingRetriever` runs a list of postprocessors, in order, on the result of its retriever ([ADR 0008](./docs/adr/0008-a-search-is-composed-of-retrievers-that-wrap-retrievers-and-a-list-of-postprocessors.md)).

```ts
// Planned API.
import {
  Collapse,
  ContextWindow,
  LongContextReorder,
  MaximalMarginalRelevance,
  PostprocessingRetriever,
  Rerank,
  SimilarityCutoff,
} from '@zukhruf/retrieval';

const search = new PostprocessingRetriever({
  retriever: hybrid,
  postprocessors: [
    new Rerank({ model: rerankingModel, topN: 20 }), // AI SDK rerank
    new SimilarityCutoff({ threshold: 0.3 }),
    new MaximalMarginalRelevance({
      model: embeddingModel,
      lambda: 0.5,
      topK: 8,
    }), // lambda 1 = relevance only
    new Collapse({ field: 'source', size: 1 }), // one passage per source
    new ContextWindow({ store, windowSize: 3 }), // the store of the retrievers
    new LongContextReorder(),
  ],
});

const results = await search.retrieve('rotate a key', {
  topK: 50,
  includeVectors: true,
});
```

`MaximalMarginalRelevance` compares the vectors of the passages, so its retriever runs with `includeVectors: true`. Its `model` embeds the query, and the relevance of a passage is the cosine similarity of the two vectors (ADR 0008, the proposed amendment of 2026-11-23).

## Search many queries at once

Batch search is part of vector search. Each embedding retriever has `retrieveMany` beside `retrieve`. It embeds the queries in one model call and runs one SQL query: `CROSS JOIN LATERAL` on Postgres, `CROSS APPLY` over the query vectors of one `OPENJSON` parameter on SQL Server. The SQLite form waits on a cost probe (#5422) ([ADR 0003](./docs/adr/0003-an-embedding-retriever-runs-the-vector-search-in-the-sql-of-its-engine-one-query-or-a-batch.md)).

```ts
// Planned API.
const lists = await retriever.retrieveMany(['rotate a key', 'revoke a token'], {
  topK: 5,
});
// lists[0] is the result of 'rotate a key', lists[1] of 'revoke a token'
```

## Filter by metadata

A filter has Haystack's shape: AND, OR and NOT over `== != > >= < <= in "not in"` ([ADR 0009](./docs/adr/0009-a-filter-has-the-shape-of-haystacks-filters.md)). A field is a passage field (`source`, `seq`, `start`, `end`) or a metadata column, `metadata.<column>`. An engine retriever runs the filter as SQL `WHERE` in the same query.

```ts
// Planned API.
const results = await retriever.retrieve('rotate a key', {
  filter: {
    operator: 'AND',
    conditions: [
      { field: 'metadata.product', operator: '==', value: 'vault' },
      { field: 'metadata.year', operator: '>=', value: 2025 },
    ],
  },
});
```

On Postgres, pgvector filters after the approximate index scan, so a filtered call can give fewer than `topK` passages ([pgvector README](https://github.com/pgvector/pgvector/blob/master/README.md)).

## Errors

| Error                                         | When                                                                                                                      |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `ModelMismatchError`                          | The query model of an embedding retriever has another provider or model id than the stored vectors, before the model call |
| `DimensionMismatchError` (`@zukhruf/vectors`) | The query vector has other dimensions than the stored vectors, after the model call. `expected` and `actual`              |
| `VectorMissingError`                          | `MaximalMarginalRelevance` gets a passage without a vector: the call did not ask for vectors                              |

An error of the model, of the engine or of the reranking model reaches the caller as it is. An aborted call rejects with the reason of its `abortSignal`.

## What the package does not do

- **It does not cut or embed documents.** elt loads, cuts and embeds them, and writes the passage contract (elt #5401). Cutting text moves to its own zukhruf package (#5414) ([ADR 0001](./docs/adr/0001-the-package-is-the-query-side-of-rag-and-reads-a-passage-contract-that-elt-writes.md)).
- **It does not ship adapters for live sources.** A web search or the API of a product is an adapter of the host that implements `Retriever` ([ADR 0002](./docs/adr/0002-a-retriever-is-a-port-for-any-source.md)).
- **It does not make agent tools.** An AI SDK tool over a retriever is the consumer's code.
- **It does not write the keyword index or the vector index.** elt writes both; this package only queries them ([ADR 0004](./docs/adr/0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md)).

## Who uses it

No consumer uses it yet. These moves are forced onto it after it ships.

| Consumer        | How                                                                                                                                                        | Record       |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| deepagents      | `@deepagents/retrieval` goes; toolbox `search_content_tool` and the orchestrator move to this package and elt                                              | #5406        |
| deepagents      | `ContextStore.searchMessages` (FTS5, `ts_rank`, `CONTAINSTABLE`) moves to the keyword retrievers, with one score direction                                 | #5417, #4884 |
| April           | the TB2 explorer moves to an elt push source, the Vectorizer and `SqliteEmbeddingRetriever`; its hand collapse of passages to documents becomes `Collapse` | #5407        |
| text2sql        | the two `toFtsQuery` copies move to the keyword retrievers                                                                                                 | #5410        |
| datahub         | the planned third FTS5 BM25 place uses the keyword retrievers; its staff search fusion uses the fusions                                                    | #3451, #3426 |
| Meddit          | its evidence layer moves onto the package after it ships                                                                                                   | #5378        |
| `@zukhruf/mteb` | keeps its MTEB port of `HybridSearch`; it does not move                                                                                                    | #5400        |

## The same concepts in other systems

| Concept                     | Other systems                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Passage`                   | LlamaIndex `TextNode` ([schema.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/schema.py)); LangChain `Document` ([document.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-core/src/documents/document.ts)); Haystack `Document` ([document.py](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/dataclasses/document.py))                                                                                                                                                        |
| `ScoredPassage`             | LlamaIndex `NodeWithScore`; .NET `VectorSearchResult<TRecord>{Record, Score}` ([vector search](https://learn.microsoft.com/en-us/dotnet/ai/vector-stores/vector-search))                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Retriever.retrieve`        | LlamaIndex `BaseRetriever.retrieve` ([base_retriever.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/base/base_retriever.py)); LangChain `BaseRetriever` ([retrievers/index.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-core/src/retrievers/index.ts)); Semantic Kernel `ITextSearch` ([text search](https://learn.microsoft.com/en-us/semantic-kernel/concepts/text-search/text-search-abstractions))                                                                                            |
| engine retrievers           | Haystack's retrievers for each document store ([retrievers](https://docs.haystack.deepset.ai/docs/retrievers))                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| passage store as the root   | Haystack `PgvectorEmbeddingRetriever(document_store=...)` and `PgvectorKeywordRetriever(document_store=...)` over `PgvectorDocumentStore(schema_name, table_name, language)` ([embedding_retriever.py](https://raw.githubusercontent.com/deepset-ai/haystack-core-integrations/main/integrations/pgvector/src/haystack_integrations/components/retrievers/pgvector/embedding_retriever.py)); LlamaIndex `VectorStoreIndex.as_retriever()`; LangChain `VectorStore.asRetriever()`                                                                                                            |
| `topK`, `includeVectors`    | Haystack `top_k` = 10 ([document_store.py](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/document_stores/in_memory/document_store.py)), `return_embedding`; Mastra `topK` = 10 ([pg](https://mastra.ai/reference/vectors/pg)); .NET `IncludeVectors` ([VectorSearchOptions](https://learn.microsoft.com/en-us/dotnet/api/microsoft.extensions.vectordata.vectorsearchoptions-1))                                                                                                                                                                                      |
| `Filter`                    | Haystack filters ([metadata filtering](https://docs.haystack.deepset.ai/docs/metadata-filtering)); LlamaIndex `MetadataFilters` ([types.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/vector_stores/types.py)); Qdrant `filter` ([search](https://qdrant.tech/documentation/search/search/))                                                                                                                                                                                                                                           |
| `FusionRetriever`           | LlamaIndex `QueryFusionRetriever` ([fusion_retriever.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/retrievers/fusion_retriever.py)); LangChain `EnsembleRetriever` ([ensemble.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-classic/src/retrievers/ensemble.ts)); Elasticsearch `rrf` ([rrf retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/rrf-retriever)); Qdrant `prefetch` ([hybrid queries](https://qdrant.tech/documentation/concepts/hybrid-queries/)) |
| score fusions               | Weaviate `relativeScoreFusion` ([hybrid](https://docs.weaviate.io/weaviate/search/hybrid)); OpenSearch `min_max` ([normalization processor](https://docs.opensearch.org/latest/search-plugins/search-pipelines/normalization-processor/)); Haystack `distribution_based_rank_fusion` ([document_joiner.py](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/components/joiners/document_joiner.py)); Qdrant `dbsf`                                                                                                                                                       |
| `MultiQueryRetriever`, HyDE | LangChain `MultiQueryRetriever` ([multi_query.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-classic/src/retrievers/multi_query.ts)), `HydeRetriever` ([HyDE](https://docs.langchain.com/oss/javascript/integrations/retrievers/hyde))                                                                                                                                                                                                                                                                                                                  |
| `PostprocessingRetriever`   | LangChain `ContextualCompressionRetriever` ([contextual_compression.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-classic/src/retrievers/contextual_compression.ts)); LlamaIndex `node_postprocessors` ([types.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/postprocessor/types.py))                                                                                                                                                                                                             |
| `MaximalMarginalRelevance`  | Elasticsearch `diversify` `lambda` ([diversify retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/diversify-retriever)); Weaviate `balance` ([1.39](https://weaviate.io/blog/weaviate-1-39-release)); Qdrant `mmr` `diversity`, 1 = diverse ([search relevance](https://qdrant.tech/documentation/search/search-relevance/))                                                                                                                                                                                                                               |
| `Collapse`                  | Elasticsearch `collapse` ([standard retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/standard-retriever)); Vespa `collapsesize` ([query API](https://docs.vespa.ai/en/reference/api/query.html)); Qdrant `query_points_groups` ([search](https://qdrant.tech/documentation/search/search/))                                                                                                                                                                                                                                                              |
| `ContextWindow`             | Haystack `SentenceWindowRetriever` ([sentence_window_retriever.py](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/components/retrievers/sentence_window_retriever.py)); LlamaIndex `PrevNextNodePostprocessor`                                                                                                                                                                                                                                                                                                                                                         |
| `LongContextReorder`        | LangChain `LongContextReorder` ([reference](https://reference.langchain.com/python/langchain-community/document_transformers/long_context_reorder/LongContextReorder)); Haystack `LostInTheMiddleRanker` ([rankers](https://docs.haystack.deepset.ai/docs/rankers))                                                                                                                                                                                                                                                                                                                         |
| hybrid search in SQL        | Alex Garcia's sqlite-vec recipe, RRF k 60 in SQL ([hybrid search](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html))                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| passage contract            | pgai `create_vectorizer` ([API reference](https://raw.githubusercontent.com/timescale/pgai/main/docs/vectorizer/api-reference.md)); Airbyte pgvector ([destination](https://docs.airbyte.com/integrations/destinations/pgvector))                                                                                                                                                                                                                                                                                                                                                           |

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
// @zukhruf/retrieval (planned)
import type { EmbeddingModel, LanguageModel, RerankingModel } from 'ai';

type Passage = {
  readonly id: string;
  readonly text: string;
  readonly source: string;
  readonly seq: number;
  readonly start: number;
  readonly end: number;
  readonly metadata: Readonly<Record<string, unknown>>;
};
type ScoredPassage = {
  readonly passage: Passage;
  readonly score: number;
  readonly vector?: readonly number[];
}; // higher is better

type Filter =
  | {
      readonly operator: 'AND' | 'OR' | 'NOT';
      readonly conditions: readonly Filter[];
    }
  | {
      readonly field: string; // 'source' | 'seq' | 'start' | 'end' | `metadata.${string}`
      readonly operator:
        '==' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'not in';
      readonly value: unknown;
    };

type RetrieveOptions = {
  readonly topK?: number; // 10
  readonly filter?: Filter;
  readonly includeVectors?: boolean; // false
  readonly abortSignal?: AbortSignal;
};

interface Retriever {
  retrieve(query: string, options?: RetrieveOptions): Promise<ScoredPassage[]>;
}
interface BatchRetriever extends Retriever {
  retrieveMany(
    queries: readonly string[],
    options?: RetrieveOptions,
  ): Promise<ScoredPassage[][]>; // in the order of the queries
}

interface Fusion {
  fuse(
    lists: readonly (readonly ScoredPassage[])[],
    weights: readonly number[],
  ): ScoredPassage[];
}
function reciprocalRankFusion(options?: { k?: number }): Fusion; // k 60, ranks from 1
function relativeScoreFusion(): Fusion; // min-max
function distributionBasedScoreFusion(): Fusion; // mean ± 3σ

class FusionRetriever implements Retriever {
  constructor(options: {
    retrievers: readonly Retriever[];
    fusion?: Fusion; // reciprocalRankFusion({ k: 60 })
    weights?: readonly number[]; // 1 each
    rankWindowSize?: number; // the topK of the call
  });
}
class MultiQueryRetriever implements Retriever {
  constructor(options: {
    retriever: Retriever;
    model: LanguageModel;
    queryCount?: number; // 4
    fusion?: Fusion; // reciprocalRankFusion({ k: 60 })
  });
}
class HydeRetriever implements Retriever {
  constructor(options: { retriever: Retriever; model: LanguageModel });
}

interface Postprocessor {
  postprocess(
    passages: readonly ScoredPassage[],
    query: string,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ScoredPassage[]>;
}
class PostprocessingRetriever implements Retriever {
  constructor(options: {
    retriever: Retriever;
    postprocessors: readonly Postprocessor[];
  });
}
class Rerank implements Postprocessor {
  constructor(options: { model: RerankingModel; topN?: number }); // every passage when topN is absent
}
class SimilarityCutoff implements Postprocessor {
  constructor(options: { threshold: number }); // keeps score >= threshold
}
class MaximalMarginalRelevance implements Postprocessor {
  constructor(options: {
    model: EmbeddingModel; // embeds the query (proposed amendment of ADR 0008)
    lambda?: number; // 0.5; 1 = relevance only
    topK: number;
  });
}
class Collapse implements Postprocessor {
  constructor(options?: {
    field?: 'source' | 'seq' | 'start' | 'end' | `metadata.${string}`; // 'source'
    size?: number; // 1
  });
}
class LongContextReorder implements Postprocessor {}
class ContextWindow implements Postprocessor {
  constructor(options: { store: PassageStore; windowSize?: number }); // 3
}

interface PassageStore {
  get(ids: readonly string[]): Promise<ReadonlyMap<string, Passage>>;
  neighbours(options: {
    source: string;
    seq: number;
    windowSize: number;
  }): Promise<Passage[]>;
}

class ModelMismatchError extends Error {
  readonly stored: { provider: string; modelId: string };
  readonly query: { provider: string; modelId: string }; // before the model call; other dimensions are DimensionMismatchError of @zukhruf/vectors (ADR 0010)
}
class VectorMissingError extends Error {
  readonly passageId: string;
}

// @zukhruf/retrieval/sqlite
class SqliteEmbeddingRetriever implements BatchRetriever {
  constructor(options: {
    store: SqlitePassageStore;
    vectors: string;
    model: EmbeddingModel;
  });
}
class SqliteBM25Retriever implements Retriever {
  constructor(options: {
    store: SqlitePassageStore;
    index: string; // the FTS5 table
    operator?: 'AND' | 'OR';
  }); // 'AND'
}
class SqlitePassageStore implements PassageStore {
  constructor(options: { database: DatabaseSync; passages: string }); // SQLite has no schema
}

// @zukhruf/retrieval/postgres
type PostgresSession = {
  query(
    sql: string,
    parameters: readonly unknown[],
  ): Promise<readonly Record<string, unknown>[]>;
};
class PgvectorEmbeddingRetriever implements BatchRetriever {
  constructor(options: {
    store: PostgresPassageStore;
    vectors: string;
    model: EmbeddingModel;
  });
}
class PgvectorKeywordRetriever implements Retriever {
  constructor(options: {
    store: PostgresPassageStore;
    index: { column: string; configuration?: string }; // 'english'
    operator?: 'AND' | 'OR';
  }); // 'AND'
}
class PostgresPassageStore implements PassageStore {
  constructor(options: {
    session: PostgresSession;
    schema?: string; // the search_path of the session when absent
    passages: string;
  });
}

// @zukhruf/retrieval/sqlserver
type SqlServerSession = {
  query(
    sql: string,
    parameters: Readonly<Record<string, unknown>>,
  ): Promise<readonly Record<string, unknown>[]>;
};
class SqlServerEmbeddingRetriever implements BatchRetriever {
  constructor(options: {
    store: SqlServerPassageStore;
    vectors: string;
    model: EmbeddingModel;
  });
}
class SqlServerKeywordRetriever implements Retriever {
  constructor(options: {
    store: SqlServerPassageStore;
    index: { table: string }; // the base table with the full-text index on [text]
    operator?: 'AND' | 'OR';
  }); // 'AND'
}
class SqlServerPassageStore implements PassageStore {
  constructor(options: {
    session: SqlServerSession;
    schema?: string; // the default schema of the user when absent
    passages: string;
  });
}
```

## Documentation

**Decisions**

- [ADR 0001](./docs/adr/0001-the-package-is-the-query-side-of-rag-and-reads-a-passage-contract-that-elt-writes.md): the package is the query side of RAG and reads a passage contract that elt writes.
- [ADR 0002](./docs/adr/0002-a-retriever-is-a-port-for-any-source.md): a retriever is a port for any source.
- [ADR 0003](./docs/adr/0003-an-embedding-retriever-runs-the-vector-search-in-the-sql-of-its-engine-one-query-or-a-batch.md): an embedding retriever runs the vector search in the SQL of its engine, one query or a batch.
- [ADR 0004](./docs/adr/0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md): a keyword retriever queries the keyword index that elt writes.
- [ADR 0005](./docs/adr/0005-a-score-is-higher-for-a-better-passage.md): a score is higher for a better passage.
- [ADR 0006](./docs/adr/0006-a-retriever-gives-10-passages-when-the-caller-gives-no-topk.md): a retriever gives 10 passages when the caller gives no topK.
- [ADR 0007](./docs/adr/0007-reciprocal-rank-fusion-is-the-default-fusion-with-k-60-and-ranks-from-1.md): reciprocal rank fusion is the default fusion, with k 60 and ranks from 1.
- [ADR 0008](./docs/adr/0008-a-search-is-composed-of-retrievers-that-wrap-retrievers-and-a-list-of-postprocessors.md): a search is composed of retrievers that wrap retrievers and a list of postprocessors.
- [ADR 0009](./docs/adr/0009-a-filter-has-the-shape-of-haystacks-filters.md): a filter has the shape of Haystack's filters.
- [ADR 0010](./docs/adr/0010-an-embedding-retriever-refuses-a-query-model-whose-identity-differs-from-the-stored-vectors.md): an embedding retriever refuses a query model whose identity differs from the stored vectors.
- [ADR 0011](./docs/adr/0011-the-package-is-in-the-base-layer.md): the package is in the base layer.
- [ADR 0012](./docs/adr/0012-the-package-is-zukhruf-retrieval-and-its-port-is-retriever-with-retrieve-after-go.md): the package is @zukhruf/retrieval, and its port is Retriever with retrieve, after Go.
