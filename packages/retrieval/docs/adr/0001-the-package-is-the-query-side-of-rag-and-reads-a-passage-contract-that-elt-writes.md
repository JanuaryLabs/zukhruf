# The package is the query side of RAG and reads a passage contract that elt writes

Superseded in part on 2026-11-26 (#5586) for "It never cuts and never embeds documents. It embeds only the query." elt cuts and embeds the documents for the index, and the package never writes a vector; a reranker may embed the text of the candidates of a query when that query runs, as `EmbeddingRerankRetriever` does ([ADR 0022](./0022-a-reranker-may-embed-the-text-of-the-candidates-when-the-query-runs.md)).

Superseded in part on 2026-11-25 (#5584) for the type of a passage of the contract. It is `StoredPassage<M>`, a `Passage<M>` with `source`, `seq`, `start` and `end`; a passage of any other source has only `id`, `text` and `metadata` ([ADR 0015](./0015-a-passage-is-typed-by-its-metadata-and-only-a-stored-passage-has-source-seq-start-and-end.md)). The rest of the decision below stays true.

Status: accepted by Ezz on 2026-11-23 ("Approve, write the paper"). Before that, Ezz set the scope: "focusing on the search aspect only not ingestion. this elt job?", and for the keyword index: "Index in elt, query in retrieval".

A RAG system has two sides. The ingestion side loads documents, cuts them into passages, embeds the passages and writes indexes. The query side takes a query and gives back the best passages. `@deepagents/retrieval` did both, with its own store, embedder and connectors (backlog #5406). elt already does the ingestion side: it loads sources, cuts text (`@eltjs/chunking`) and embeds it (`@eltjs/embedding`), and on SQL Server it writes a vector index and a search function `marts.<name>_nearest` (ADR 0014 of elt-sqlserver, `packages/destinations/sqlserver/docs/adr/0014-each-vector-index-has-a-search-function-in-marts.md` in the elt repository, #5125).

The leaders keep the two sides apart and join them by a stored contract. pgai's `create_vectorizer` writes `<source>_embedding_store` and a view `<source>_embedding` that joins the source table ([pgai vectorizer API](https://raw.githubusercontent.com/timescale/pgai/main/docs/vectorizer/api-reference.md), [overview](https://raw.githubusercontent.com/timescale/pgai/main/docs/vectorizer/overview.md)). Haystack's document store updates its BM25 statistics when it writes the documents, and its retrievers only read ([in-memory document store](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/document_stores/in_memory/document_store.py)). Airbyte's pgvector destination writes the chunks and their metadata fields ([Airbyte pgvector](https://docs.airbyte.com/integrations/destinations/pgvector)).

## Decision

- The package is the query side of RAG. It never cuts and never embeds documents. It embeds only the query.
- It reads the **passage contract** that elt writes:
  - passages: `id, source, seq, start, end, text` and the metadata columns of the source row; on SQLite also an integer `rowid`, native in a rowid table or a column `AS rowid` in a view, which the keyword index joins on;
  - passage vectors: `id, vector, model`, where `model` is the model identity ([ADR 0010](./0010-an-embedding-retriever-refuses-a-query-model-whose-identity-differs-from-the-stored-vectors.md));
  - a keyword index over the same passages: FTS5 with external content on SQLite, `tsvector` with a GIN index on Postgres, a full-text index on SQL Server ([ADR 0004](./0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md)).
- A `Passage` is one row of the contract: `{ id, text, source, seq, start, end, metadata }`. `source` is the key of the source row (LlamaIndex `relationships[SOURCE]`, Haystack `meta.source_id`, the pgai foreign key). `seq` is the order of the passage in its source (pgai `chunk_seq`). `start` and `end` are offsets in code points in the text of the source, and `end` is exclusive, as elt's Chunking counts them (elt `packages/chunking/docs/adr/0006-each-chunk-gives-its-offsets-and-its-count-of-tokens.md`). LlamaIndex's `start_char_idx` and `end_char_idx` are Python string indexes, which also count code points ([schema.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/schema.py)). A JavaScript string counts UTF-16 code units, so the two counts differ for a code point outside the Basic Multilingual Plane.
- elt's Vectorizer is the standard writer of the contract (elt #5401).

## Considered Options

- **The package also ingests, as `@deepagents/retrieval` did.** It lost: elt already loads, cuts and embeds, so two writers would keep two stores of the same passages. Ezz asked "this elt job?" and chose "Converge into elt" for `Collection` (#5416).
- **The package reads any table through a mapper callback (the earlier paper, after Semantic Kernel's `VectorStoreTextSearch`).** It lost: each host then rebuilds the join of a vector to its text and its source, and the query side cannot rely on a source key, an order or a model identity.
- **The package owns its own table layout, as LlamaIndex, LangChain and Mastra stores do.** It lost: their stores create fixed tables (README, "Why not an npm package"), and elt already writes the data.

## Consequences

- elt gets the forced changes that the contract needs: a push source, one Vectorizer declaration, a keyword index dataset, a pgvector column and index on Postgres, source metadata through the passages view and a readable model identity (#5401 to #5405).
- Cutting text moves to its own zukhruf package (#5414), not into this one.
- A host that writes the contract by hand, without elt, works the same, because the package reads only the tables.

## Amendment 2026-11-23

Accepted by Ezz on 2026-11-23: the metadata ("They stand"), the key ("Integer key on passages"). A metadata column is every column of the passages other than `rowid, id, source, seq, start, end, text`, under its own name; `Passage.metadata` holds each of them, NULL as `null`. On SQLite the passages relation has an integer `rowid`, a rowid table natively or a view by an integer column `AS rowid`, because the keyword index joins on it ([ADR 0004](./0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md)).

## Amendment 2026-11-23: the passages on Postgres

Accepted by Ezz on 2026-11-23 ("They stand"). The Postgres retrievers and `PostgresPassageStore` read a passage row as one cell, `to_jsonb(p)::text`, and parse it. This keeps each metadata column under its own name, even when it has the name of a cell that the search adds (`distance`, `vector`, `passage`, `query`): a driver gives a row as an object, so two cells of one name would keep only one. It also gives the same values through every driver. A metadata value is therefore a JSON value: a `timestamp` is ISO text, a `numeric` or `bigint` is a number, and a `bytea` is `\x` text. The leaders keep metadata as JSON too: Haystack `meta JSONB`, LlamaIndex `metadata_`, LangChain `cmetadata`. A `tsvector` column of the passages is a keyword index, not metadata ([ADR 0004](./0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md)), as the SQLite `rowid` is not metadata. A table or view name is one quoted identifier, as on SQLite. A schema is the `schema` option of `PostgresPassageStore`, and the `search_path` of the session finds each relation when it is absent (the amendment of 2026-11-24).

## Amendment 2026-11-24: the passage store is the root of the composition

Accepted by Ezz on 2026-11-24 ("Store as composition root (Recommended)"), after "follow our pricinple of not representing illegal state" and "make this composable without presenting a [il]legal state and no workarounds" (backlog #5399). Until then each engine class took the connection and the passages again: a `FusionRetriever` could fuse retrievers over two sessions or two tables, a `ContextWindow` could read neighbours from another table than its retriever, and the configuration of a keyword retriever could differ from the index that elt built, with no error. Now each fact has one place:

- The passage store of an engine holds the connection, the passages relation and, on Postgres and SQL Server, `schema?`. `SqlitePassageStore { database, passages }` has no schema in its type: SQLite has none. `PostgresPassageStore { session, schema?, passages }`.
- The schema qualifies every relation of the contract of that store: the passages, the passage vectors and the keyword index, as Haystack's one `schema_name` of `PgvectorDocumentStore` does. When it is absent, the `search_path` of the session finds each relation.
- The engine retrievers take `store` and only their own part: `vectors` and `model` for an embedding retriever, `index` and `matching` for a keyword retriever ([ADR 0003](./0003-an-embedding-retriever-runs-the-vector-search-in-the-sql-of-its-engine-one-query-or-a-batch.md), [ADR 0004](./0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md), [ADR 0018](./0018-each-keyword-retriever-matches-in-the-strongest-form-of-its-engine.md)). `ContextWindow` keeps `{ store }`, so one store object composes the whole search.
- A retriever reads the connection and the relations of its store through a function of the store's module that the subpath does not export, as `protocolKeyOf` of `@zukhruf/ssh` reads a `PrivateKey` (`packages/ssh/src/private-key.ts`): a static block of the class gives that function the private fields. The store has no public getter.

Haystack's `PgvectorEmbeddingRetriever` and `PgvectorKeywordRetriever` take `document_store`, and `PgvectorDocumentStore` holds `schema_name`, `table_name` and `language`. LlamaIndex (`VectorStoreIndex.as_retriever()`), LangChain (`VectorStore.asRetriever()`) and .NET's Microsoft.Extensions.VectorData (a collection of a store) compose the same way.

## Amendment 2026-11-24: the passages on SQL Server

The store, its schema and its quoting are accepted by Ezz on 2026-11-24 ("Store as composition root (Recommended)", backlog #5399). The other choices of this amendment are accepted by Ezz on 2026-11-24 ("They stand").

- **Accepted.** `SqlServerPassageStore { session, schema?, passages }` holds the connection, the schema and the passages, as `PostgresPassageStore` does. The schema qualifies every relation of the contract: the passages, the passage vectors and the table of the full-text index. Each part is one identifier in brackets, `[name]`, with a `]` inside it doubled, as Microsoft.Extensions.VectorData's `SqlServerCommandBuilder` writes a name. SQL Server has no `search_path`: when `schema` is absent, the default schema of the user finds each relation.
- **Accepted by Ezz on 2026-11-24 ("They stand").** A passage row is one cell, `(SELECT p.* FOR JSON PATH, WITHOUT_ARRAY_WRAPPER, INCLUDE_NULL_VALUES)`, for the reason of the Postgres amendment above: each metadata column keeps its name beside the cells of the search. A metadata value is a JSON value: a `BIT` is `true` or `false`, a `DATETIME2` is ISO text with 7 digits and no zone, and a `BIGINT` is a number, which loses precision above 2^53 as a `bigint` does on Postgres (probe P5 of 2026-11-24).
- **Accepted by Ezz on 2026-11-24 ("They stand").** Every id and source that the store and the retrievers compare or order is `COLLATE Latin1_General_100_BIN2`: UTF-16 code units, the order of JavaScript's `sort()`. The default collation of a server is usually case-insensitive, so without it `get(['A'])` would give passage `a`, and a tie would order `a` before `B`, unlike SQLite and Postgres. A filter compares in the collation of its column, because `COLLATE` on a column that is not text is an error (447). The contract's id column is `NVARCHAR(450) COLLATE Latin1_General_100_BIN2`: under a case-insensitive collation its key refuses ids that differ only in case (2627), and a full-text key is at most 900 bytes (elt #5401).

## Amendment 2026-11-24: the passages of a source tile it

Accepted by Ezz on 2026-11-24 ("Go with all four (Recommended)", backlog #5399). The passages of one source tile its text: the writer keeps the white space, so that each character of the source, a space or a line break too, is in a passage; two passages can overlap; and no passage starts after the end of the passages before it, in the order of `start`. So the text of passages from `start` to `end`, merged without repeating an overlap, is the exact part of the source from `start` to `end`. Haystack's `keep_white_spaces` keeps the white space of a split the same way. Without this rule a writer could drop the space between two sentences, and `ContextWindow` would join them as `key.Keep` with no error: the README did so until this amendment. A window with a gap is a `PassageGapError` ([ADR 0008](./0008-a-search-is-composed-of-retrievers-that-wrap-retrievers-and-a-list-of-postprocessors.md), the amendment of 2026-11-24).
