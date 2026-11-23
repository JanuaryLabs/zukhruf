# The package is the query side of RAG and reads a passage contract that elt writes

Status: accepted by Ezz on 2026-11-23 ("Approve, write the paper"). Before that, Ezz set the scope: "focusing on the search aspect only not ingestion. this elt job?", and for the keyword index: "Index in elt, query in retrieval".

A RAG system has two sides. The ingestion side loads documents, cuts them into passages, embeds the passages and writes indexes. The query side takes a query and gives back the best passages. `@deepagents/retrieval` did both, with its own store, embedder and connectors (backlog #5406). elt already does the ingestion side: it loads sources, cuts text (`@eltjs/chunking`) and embeds it (`@eltjs/embedding`), and on SQL Server it writes a vector index and a search function `marts.<name>_nearest` (ADR 0014 of elt-sqlserver, `packages/destinations/sqlserver/docs/adr/0014-each-vector-index-has-a-search-function-in-marts.md` in the elt repository, #5125).

The leaders keep the two sides apart and join them by a stored contract. pgai's `create_vectorizer` writes `<source>_embedding_store` and a view `<source>_embedding` that joins the source table ([pgai vectorizer API](https://raw.githubusercontent.com/timescale/pgai/main/docs/vectorizer/api-reference.md), [overview](https://raw.githubusercontent.com/timescale/pgai/main/docs/vectorizer/overview.md)). Haystack's document store updates its BM25 statistics when it writes the documents, and its retrievers only read ([in-memory document store](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/document_stores/in_memory/document_store.py)). Airbyte's pgvector destination writes the chunks and their metadata fields ([Airbyte pgvector](https://docs.airbyte.com/integrations/destinations/pgvector)).

## Decision

- The package is the query side of RAG. It never cuts and never embeds documents. It embeds only the query.
- It reads the **passage contract** that elt writes:
  - passages: `id, source, seq, start, end, text` and the metadata columns of the source row;
  - passage vectors: `id, vector, model`, where `model` is the model identity ([ADR 0010](./0010-an-embedding-retriever-refuses-a-query-model-whose-identity-differs-from-the-stored-vectors.md));
  - a keyword index over the same passages: FTS5 with external content on SQLite, `tsvector` with a GIN index on Postgres, a full-text index on SQL Server ([ADR 0004](./0004-a-keyword-retriever-queries-the-keyword-index-that-elt-writes.md)).
- A `Passage` is one row of the contract: `{ id, text, source, seq, start, end, metadata }`. `source` is the key of the source row (LlamaIndex `relationships[SOURCE]`, Haystack `meta.source_id`, the pgai foreign key). `seq` is the order of the passage in its source (pgai `chunk_seq`). `start` and `end` are character offsets (LlamaIndex `start_char_idx`, `end_char_idx`; [schema.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/schema.py)).
- elt's Vectorizer is the standard writer of the contract (elt #5401).

## Considered Options

- **The package also ingests, as `@deepagents/retrieval` did.** It lost: elt already loads, cuts and embeds, so two writers would keep two stores of the same passages. Ezz asked "this elt job?" and chose "Converge into elt" for `Collection` (#5416).
- **The package reads any table through a mapper callback (the earlier paper, after Semantic Kernel's `VectorStoreTextSearch`).** It lost: each host then rebuilds the join of a vector to its text and its source, and the query side cannot rely on a source key, an order or a model identity.
- **The package owns its own table layout, as LlamaIndex, LangChain and Mastra stores do.** It lost: their stores create fixed tables (README, "Why not an npm package"), and elt already writes the data.

## Consequences

- elt gets the forced changes that the contract needs: a push source, one Vectorizer declaration, a keyword index dataset, a pgvector column and index on Postgres, source metadata through the passages view and a readable model identity (#5401 to #5405).
- Cutting text moves to its own zukhruf package (#5414), not into this one.
- A host that writes the contract by hand, without elt, works the same, because the package reads only the tables.
