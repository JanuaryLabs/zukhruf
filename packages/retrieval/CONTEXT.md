# Retrieval

The query side of retrieval-augmented generation: a query goes in, and the best passages of a passage contract or of another source come out, best first. The package never cuts or embeds documents; elt writes the passages and their indexes. The words below have one meaning each in its documents.

## Language

### Passages

**Passage**:
One part of a source that a search gives back, from any retriever: `Passage<M> = { id, text, metadata }`, where `M` is the type of the metadata, the host's own fields (LangChain.js `Document<Metadata>`). The term is the one of information retrieval for a part of a document ([ADR 0012](./docs/adr/0012-the-package-is-zukhruf-retrieval-and-its-port-is-retriever-with-retrieve-after-go.md), [ADR 0015](./docs/adr/0015-a-passage-is-typed-by-its-metadata-and-only-a-stored-passage-has-source-seq-start-and-end.md)).
_Avoid_: Document (the whole source row), Node (LlamaIndex), Record (.NET), Chunk (the output of a cut, on the ingestion side), Hit

**Stored passage**:
A passage of the passage contract: `StoredPassage<M> = Passage<M> & { source, seq, start, end }`. The engine retrievers and the passage stores give it; a live source, such as a web search, gives a passage without them. `start` and `end` are offsets in code points in the text of the source, and `end` is exclusive, as elt's Chunking counts them (elt `packages/chunking/docs/adr/0006-each-chunk-gives-its-offsets-and-its-count-of-tokens.md`). LlamaIndex puts the offsets on `TextNode`, not on every node ([ADR 0015](./docs/adr/0015-a-passage-is-typed-by-its-metadata-and-only-a-stored-passage-has-source-seq-start-and-end.md)).
_Avoid_: Row, contract passage, chunk

**Source**:
The key of the row or file that a passage comes from. Two passages with the same source are parts of one document. LlamaIndex keeps it as `relationships[SOURCE]`, Haystack as `meta.source_id`, pgai as the foreign key of the chunk.
_Avoid_: Parent, document id, origin

**Passage contract**:
The tables that elt writes and that the engine retrievers read: the passages (`id, source, seq, start, end, text` and the metadata columns of the source row; on SQLite also an integer `rowid`, which the keyword index joins on), the passage vectors (`id, vector, model`) and a keyword index over the same passages ([ADR 0001](./docs/adr/0001-the-package-is-the-query-side-of-rag-and-reads-a-passage-contract-that-elt-writes.md)).
_Avoid_: Schema, store, collection, index (for the whole contract)

**Passage store**:
The root of the composition of an engine: it holds the connection, the passages relation and, on Postgres and SQL Server, the schema of the contract, each in one place. The engine retrievers and `ContextWindow` take the store and add only their own part: the vectors and the model, or the keyword index. It reads stored passages by id and the neighbours of a passage in its source. Haystack's retrievers take a `document_store` the same way ([ADR 0001](./docs/adr/0001-the-package-is-the-query-side-of-rag-and-reads-a-passage-contract-that-elt-writes.md)).
_Avoid_: Document store, repository

**Model identity**:
The provider, the model id and the dimensions of the AI SDK embedding model that made a vector, as elt's Embedding rule stores it: `openai/text-embedding-3-small (1536 dimensions)` (elt `packages/embedding/README.md`). The passage vectors keep it, and an embedding retriever compares it with its query model: the provider and the model id before the model call (`ModelMismatchError`), the dimensions after it (`DimensionMismatchError` of `@zukhruf/vectors`) ([ADR 0010](./docs/adr/0010-an-embedding-retriever-refuses-a-query-model-whose-identity-differs-from-the-stored-vectors.md)).
_Avoid_: Model name, dimension (alone: two models can have the same dimension)

### Searches

**Query**:
What a caller searches with: a string, or a query bundle. A string is a query bundle with only `query` (LlamaIndex `QueryType = string | QueryBundle`). The `query` of a bundle is the information need: the reranker and the language models read it, and so does every search that has no text of its own ([ADR 0013](./docs/adr/0013-a-query-is-a-string-or-a-query-bundle-with-a-text-for-each-kind-of-search.md)).
_Avoid_: Question, prompt, search term

**Query bundle**:
One search request with a text for each kind of search that needs other words: `{ query, keywords?, customEmbeddings? }`, after LlamaIndex's `QueryBundle`. A host adapter adds its own fields in its own bundle type, `QueryBundle & { readonly jql: string }`, and then takes no string.
_Avoid_: Query object, request, search input

**Keywords**:
The `keywords` of a query bundle: the list of words that a keyword retriever quotes in place of the words of `query` (.NET `HybridSearchAsync(searchValue, keywords)`). It is never empty.
_Avoid_: Terms, keyword text, search string

**Custom embeddings**:
The `customEmbeddings` of a query bundle: the texts that an embedding retriever embeds in place of `query`. It searches with the mean of their vectors. `HydeRetriever` writes its passage here (LlamaIndex.TS `customEmbeddings`). It is never empty.
_Avoid_: Embedding text, embedding strs, vector query

**Retriever**:
The port of the package: an object with `retrieve(query, options)` that gives a retrieval result. Any source can implement it (Eino `Retriever.Retrieve`, Genkit `Retriever`). `Retriever<Q, P>` takes the query type `Q` and gives the passage type `P`: an engine gives stored passages, a live source passages ([ADR 0015](./docs/adr/0015-a-passage-is-typed-by-its-metadata-and-only-a-stored-passage-has-source-seq-start-and-end.md)).
_Avoid_: Searcher, text search, index, store

**Retrieval result**:
What a retrieve call gives: `{ passages, failures }`, the scored passages, best first, and the failures. Every retriever gives it, as every Elasticsearch response has `_shards` and every bleve `SearchResult` has `Status` ([ADR 0014](./docs/adr/0014-a-retrieve-call-answers-with-the-retrievers-that-answered-and-names-those-that-were-unavailable.md)).
_Avoid_: Response, search result, hits

**Failures**:
The `failures` of a retrieval result: each child of a composite that was unavailable, by its name, with its error. It is empty when nothing failed (Elasticsearch `_shards.failures`, bleve `Status.Errors`).
_Avoid_: Errors, partial, skipped

**Unavailable retriever**:
A retriever that could not answer and that a search can go on without: its adapter throws `RetrieverUnavailableError`, as Elasticsearch's `skip_unavailable` skips a cluster. Every other error is a bug, and rejects the call. `NoRetrieverAnsweredError` is a fusion none of whose children answered ([ADR 0014](./docs/adr/0014-a-retrieve-call-answers-with-the-retrievers-that-answered-and-names-those-that-were-unavailable.md)).
_Avoid_: Down source, failed source, source error

**Engine retriever**:
A retriever of this package that reads the passage contract with the SQL of one engine: SQLite, Postgres or SQL Server.
_Avoid_: Store retriever, backend

**Embedding retriever**:
An engine retriever that embeds the query and ranks the passages by the cosine similarity of their vectors, in the SQL of the engine. Haystack uses the same name (`PgvectorEmbeddingRetriever`).
_Avoid_: Vector search (the engine's search that an embedding retriever runs, ADR 0003), semantic search, dense retriever

**Keyword retriever**:
An engine retriever that ranks the passages by the keyword index: FTS5 `bm25()` on SQLite, `ts_rank_cd` on Postgres, `RANK` of `CONTAINSTABLE` on SQL Server.
_Avoid_: Full-text search, lexical search, sparse retriever, BM25 (the name of one ranking function)

**Batch search**:
One call that searches many queries at once, `retrieveMany(queries, options)`, as one model call and one SQL query. Each query is a string or a query bundle. It gives one retrieval result for each query, in the order of the queries.
_Avoid_: Bulk search, multi-search, multi-query (a multi-query is one query rewritten many times)

**topK**:
The most passages that a call gives. The default is 10 (Haystack `top_k`, Mastra `topK`).
_Avoid_: Limit, k, size, top, n

**Filter**:
A condition on passage fields and metadata columns, in Haystack's shape: AND, OR and NOT over `== != > >= < <= in "not in"` ([Haystack metadata filtering](https://docs.haystack.deepset.ai/docs/metadata-filtering)). `Filter<P>` names the stored fields of the passage type `P` and `metadata.<key>` of its metadata, each with its value type ([ADR 0015](./docs/adr/0015-a-passage-is-typed-by-its-metadata-and-only-a-stored-passage-has-source-seq-start-and-end.md)). An engine retriever runs it as SQL `WHERE`.
_Avoid_: Where, predicate, query (for the condition)

### Scores

**Score**:
The number that a retriever or a postprocessor gives a passage. A higher score is a better passage, for every retriever that gives one ([ADR 0005](./docs/adr/0005-a-score-is-higher-for-a-better-passage.md)). A retriever that gives an order only, such as a web search, gives none ([ADR 0016](./docs/adr/0016-a-scored-passage-may-have-no-score-and-a-list-is-in-the-retrievers-order.md)).
_Avoid_: Distance (lower is better), rank (a position), relevance, similarity (for the score of a keyword retriever)

**Scored passage**:
A passage with its score when the retriever gives one, and its vector when the call asks for it: `{ passage, score?, vector? }`. LlamaIndex calls it `NodeWithScore`, .NET `VectorSearchResult`; both make the score optional.
_Avoid_: Result, hit, match, search result

### Composition

**Fusion**:
The combination of the result lists of several retrievers into one list, on `Passage.id`. Three fusions ship: reciprocal rank fusion, relative score fusion (min-max) and distribution-based score fusion (mean ± 3σ).
_Avoid_: Hybrid search (one use of fusion), ensemble, join, merge

**Reciprocal rank fusion**:
A fusion that gives each passage the sum of `weight / (k + rank)` over the lists that hold it, with k 60 and ranks from 1 (Cormack, Clarke and Büttcher, SIGIR 2009; [Elasticsearch rrf](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/rrf-retriever)).
_Avoid_: RRF score (for the fused score), reciprocal rerank (LlamaIndex's name)

**Rank window**:
How many passages a fusion asks of each of its retrievers before it fuses. Elasticsearch calls it `rank_window_size`.
_Avoid_: Prefetch, candidate count, fetch-k

**Postprocessor**:
An object that changes a result list after the search: it reranks, cuts, diversifies, groups, reorders or widens the passages. LlamaIndex calls it `BaseNodePostprocessor`. `Postprocessor<R>` needs passages of at least `R` and gives back the passage type it got: `ContextWindow` needs stored passages ([ADR 0015](./docs/adr/0015-a-passage-is-typed-by-its-metadata-and-only-a-stored-passage-has-source-seq-start-and-end.md)).
_Avoid_: Compressor (LangChain), ranker (Haystack), filter (for a postprocessor)

**Rerank**:
The postprocessor that scores each passage again with an AI SDK reranking model and keeps the best `topN`.
_Avoid_: Cross-encoder (one kind of model), re-score
