# An embedding retriever runs the vector search in the SQL of its engine, one query or a batch

Status: accepted by Ezz on 2026-11-23 ("The engine's SQL"; for the batch: "Yes, part of search").

Today exact vector search runs in three ways: `VectorSearch` of `@zukhruf/embeddings` scans in JavaScript, deepagents queries a `vec0` table, and elt's SQL Server destination gives `marts.<name>_nearest(@query, @k)` over `VECTOR_SEARCH` (ADR 0014 of elt-sqlserver, `packages/destinations/sqlserver/docs/adr/0014-each-vector-index-has-a-search-function-in-marts.md` in the elt repository, #5125). Each engine has its own vector SQL: `vec_distance_cosine` in SQLite (sqlite-vec, or `install()` of `@zukhruf/vectors`, its ADR 0005), `<=>` in pgvector ([pgvector README](https://github.com/pgvector/pgvector/blob/master/README.md)), `VECTOR_DISTANCE` and `VECTOR_SEARCH` in SQL Server. Alex Garcia's hybrid recipe runs vector and keyword search as SQL in one SQLite query ([sqlite-vec hybrid search](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html)). Haystack ships one embedding retriever for each document store ([retrievers](https://docs.haystack.deepset.ai/docs/retrievers)).

## Decision

- Each engine has its own embedding retriever, in its own subpath: `SqliteEmbeddingRetriever` (`/sqlite`), `PgvectorEmbeddingRetriever` (`/postgres`), `SqlServerEmbeddingRetriever` (`/sqlserver`).
- The retriever embeds the query with its AI SDK model and sends one SQL query to the engine. The engine ranks the passages; the package keeps no vector scan in memory. `VectorSearch` of `@zukhruf/embeddings` goes (#5416).
  - SQLite: `vec_distance_cosine` over the passage vectors, from sqlite-vec or from `install()` of `@zukhruf/vectors`. The host loads one of them; the SQL is the same.
  - Postgres: the pgvector `<=>` operator.
  - SQL Server: `VECTOR_DISTANCE`, or elt's `marts.<name>_nearest` over `VECTOR_SEARCH` when the vectors have a DiskANN index.
- Batch search is part of vector search. Each embedding retriever implements `BatchRetriever`: it has `retrieveMany(queries, options)` beside `retrieve`, and gives one result list for each query, in the order of the queries. It embeds the queries in one `embedMany` call and runs one SQL query: `CROSS JOIN LATERAL` on Postgres, `CROSS APPLY` over `VECTOR_SEARCH` on SQL Server (to be probed), and on SQLite the form that the cost probe of #5422 picks.
- The score is the cosine similarity, `1 - distance` ([ADR 0005](./0005-a-score-is-higher-for-a-better-passage.md)).

## Considered Options

- **One in-memory scan class over vectors that any store gives.** It lost: Ezz chose "The engine's SQL". A scan reads every vector into the process; the engine can use its index and its filter.
- **Batch search as a loop of `retrieve` calls in the host.** It lost: Ezz ruled "Yes, part of search". A loop makes one model call and one SQL query for each query.

## Consequences

- The filter of a call becomes a SQL `WHERE` in the same query ([ADR 0009](./0009-a-filter-has-the-shape-of-haystacks-filters.md)). pgvector filters after the approximate index scan, so a filtered call can give fewer than `topK` rows ([pgvector README](https://github.com/pgvector/pgvector/blob/master/README.md)).
- The SQLite form of the batch waits on the cost probe (#5422); the SQL Server form waits on a probe of `CROSS APPLY` over `VECTOR_SEARCH`.

## Amendment 2026-11-23

Accepted by Ezz on 2026-11-23 ("They stand"). On SQLite, `retrieve` and `retrieveMany` run the same single statement: a `VALUES` table of the query vectors, `CROSS JOIN` the passage vectors, and `ROW_NUMBER() OVER (PARTITION BY query ORDER BY distance, id)` cut at `topK`. A tie of distance goes to the smaller passage id, as `VectorSearch` of `@zukhruf/embeddings` orders its ties, so a result is the same on every run. The measurement of #5422 may change this form; it does not change the result.

## Amendment 2026-11-23: the batch on Postgres

Accepted by Ezz on 2026-11-23 ("They stand"). On Postgres, `retrieve` and `retrieveMany` run one statement: a `VALUES` table of the query vectors `CROSS JOIN LATERAL` an ordered, limited scan of the passage vectors of the identity of the query, `ORDER BY "vector" <=> query, id LIMIT topK`. The ids order in bytes (`COLLATE "C"`), and the stored identities too, so a tie and `ModelMismatchError.stored` are the same as on SQLite whatever the collation of the database is. None of the leaders has a batch search on Postgres: Haystack, LlamaIndex and LangChain send one query for each search.
