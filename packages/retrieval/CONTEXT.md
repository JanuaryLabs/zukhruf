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
The root of the composition of an engine: it holds the connection, the passages relation and, on Postgres and SQL Server, the schema of the contract, each in one place. The engine retrievers and `ContextWindow` take the store and add only their own part: the vectors and the model, or the keyword index. It reads stored passages by id and the neighbours of a passage in its source. Haystack's retrievers take a `document_store` the same way ([ADR 0001](./docs/adr/0001-the-package-is-the-query-side-of-rag-and-reads-a-passage-contract-that-elt-writes.md)). Its `metadata` reads the metadata `M` of each passage from the other columns of its row, so the store and every retriever over it give `StoredPassage<M>` ([ADR 0015](./docs/adr/0015-a-passage-is-typed-by-its-metadata-and-only-a-stored-passage-has-source-seq-start-and-end.md)).
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
The `keywords` of a query bundle: the list of whole keywords that a keyword retriever matches in place of the words of `query` (.NET `HybridSearchAsync(searchValue, keywords)`). Each keyword is one phrase in the syntax of the engine, so `'heart failure'` matches those words side by side and in order. It is never empty.
_Avoid_: Terms, keyword text, search string

**Custom embeddings**:
The `customEmbeddings` of a query bundle: the texts that an embedding retriever embeds in place of `query`. It searches with the mean of their vectors. `HydeRetriever` writes its passage here (LlamaIndex.TS `customEmbeddings`). It is never empty.
_Avoid_: Embedding text, embedding strs, vector query

**Retriever**:
The port of the package: an object with `retrieve(query, options)` that gives a retrieval result. Any source can implement it (Eino `Retriever.Retrieve`, Genkit `Retriever`). `Retriever<Q, P, I>` takes the query type `Q`, gives the passage type `P` and gives items of the kind `I`: an engine gives scored stored passages, a live source of order only ranked passages ([ADR 0015](./docs/adr/0015-a-passage-is-typed-by-its-metadata-and-only-a-stored-passage-has-source-seq-start-and-end.md), [ADR 0021](./docs/adr/0021-a-retriever-says-whether-it-gives-scores-a-ranked-passage-has-none-and-a-scored-passage-always-has-one.md)). A scored retriever is a ranked one; a ranked retriever is not a scored one.
_Avoid_: Searcher, text search, index, store

**Retrieval result**:
What a retrieve call gives: `{ passages, failures }`, the ranked or scored passages, best first, and the failures. Every retriever gives it, as every Elasticsearch response has `_shards` and every bleve `SearchResult` has `Status` ([ADR 0014](./docs/adr/0014-a-retrieve-call-answers-with-the-retrievers-that-answered-and-names-those-that-were-unavailable.md)).
_Avoid_: Response, search result, hits

**Failures**:
The `failures` of a retrieval result: each child of a composite that was unavailable, by its name, with its error. A failure inside a nested fusion is named by its path, `outer:inner`, as Elasticsearch writes `cluster:index`, so a name holds no `:`. It is empty when nothing failed (Elasticsearch `_shards.failures`, bleve `Status.Errors`).
_Avoid_: Errors, partial, skipped

**Unavailable retriever**:
A retriever that could not answer and that a search can go on without: its adapter throws `RetrieverUnavailableError`, as Elasticsearch's `skip_unavailable` skips a cluster. Every other error is a bug: it aborts the signal of every sibling, with the error as the reason, and rejects the call. `NoRetrieverAnsweredError` is a fusion none of whose children answered ([ADR 0014](./docs/adr/0014-a-retrieve-call-answers-with-the-retrievers-that-answered-and-names-those-that-were-unavailable.md)).
_Avoid_: Down source, failed source, source error

**Engine retriever**:
A retriever of this package that reads the passage contract with the SQL of one engine: SQLite, Postgres or SQL Server.
_Avoid_: Store retriever, backend

**Embedding retriever**:
An engine retriever that embeds the query and ranks the passages by the cosine similarity of their vectors, in the SQL of the engine. Haystack uses the same name (`PgvectorEmbeddingRetriever`).
_Avoid_: Vector search (the engine's search that an embedding retriever runs, ADR 0003), semantic search, dense retriever

**Keyword retriever**:
An engine retriever that ranks the passages by the keyword index: FTS5 `bm25()` on SQLite, the lexemes held plus `ts_rank` (or `ts_rank_cd` under `'all'`) on Postgres, `RANK` of `FREETEXTTABLE` or `CONTAINSTABLE` on SQL Server.
_Avoid_: Full-text search, lexical search, sparse retriever, BM25 (the name of one ranking function)

**Matching**:
The `matching` option of a keyword retriever: how the words of a query find and rank passages, as a discriminated union of that engine only, under the leaders' names for the engine's own mechanism. SQLite `{ operator: 'OR', cutoffFrequency? } | { operator: 'AND' }` (Elasticsearch `operator` and `cutoff_frequency`; `{ operator: 'OR', cutoffFrequency: 20_000 }` when absent), Postgres `{ strategy: 'frequency', dropTokensThreshold? } | { strategy: 'all' }` (Meilisearch `matchingStrategy`, Typesense `drop_tokens_threshold`; `{ strategy: 'frequency', dropTokensThreshold: 10 }` when absent; Postgres has no OR), SQL Server `{ predicate: 'FREETEXT' } | { predicate: 'CONTAINS', operator: 'AND' | 'OR' }` (T-SQL; `{ predicate: 'FREETEXT' }` when absent). No form is shared across engines ([ADR 0018](./docs/adr/0018-each-keyword-retriever-matches-in-the-strongest-form-of-its-engine.md)).
_Avoid_: Operator as the name of the option (the filter's word, ADR 0009; `operator` stays a field of the SQLite and SQL Server unions), mode, match type

**Batch search**:
One call that searches many queries at once, `retrieveMany(queries, options)`, as one model call and one SQL query. Each query is a string or a query bundle. It gives one retrieval result for each query, in the order of the queries.
_Avoid_: Bulk search, multi-search, multi-query (a multi-query is one query rewritten many times)

**topK**:
The most passages that a call gives. The default is 10 (Haystack `top_k`, Mastra `topK`).
_Avoid_: Limit, k, size, top, n

**Signal**:
The optional `AbortSignal` of a call, named `signal` as in `fetch` and Node, on every async port: `retrieve`, `retrieveMany`, `postprocess`, the store's `get` and `neighbours`, and the session's `query`. Each implementation passes it to every async call it makes, and an aborted call rejects with its reason. A composite rejects at once, whatever its parts do. The AI SDK's `abortSignal` is the same signal at the model's boundary ([ADR 0017](./docs/adr/0017-every-async-port-takes-an-optional-abort-signal-and-a-composite-rejects-at-once-when-it-aborts.md)).
_Avoid_: abortSignal (outside a model call), cancellation token, ctx

**Filter**:
A condition on passage fields and metadata columns, in Haystack's shape: AND, OR and NOT over `== != > >= < <= in "not in"` ([Haystack metadata filtering](https://docs.haystack.deepset.ai/docs/metadata-filtering)). `Filter<P>` names the stored fields of the passage type `P` and `metadata.<key>` of its metadata, each with its value type ([ADR 0015](./docs/adr/0015-a-passage-is-typed-by-its-metadata-and-only-a-stored-passage-has-source-seq-start-and-end.md)). An engine retriever runs it as SQL `WHERE`.
_Avoid_: Where, predicate, query (for the condition)

### Scores

**Score**:
The number that a retriever, a fusion or a reranker gives a passage: a finite number, higher for a better passage ([ADR 0005](./docs/adr/0005-a-score-is-higher-for-a-better-passage.md)). A retriever that gives an order only, such as a web search, gives none ([ADR 0021](./docs/adr/0021-a-retriever-says-whether-it-gives-scores-a-ranked-passage-has-none-and-a-scored-passage-always-has-one.md)).
_Avoid_: Distance (lower is better), rank (a position), relevance, similarity (for the score of a keyword retriever)

**Ranked passage**:
A passage in a list of order only, and its vector when the call asks for it: `RankedPassage<P> = { passage, vector? }`. Its place in the list is its rank, and a list is best first. A live source that gives an order only, such as a web search or PubMed's Best Match, gives it (MongoDB's "Ranked Pipeline"; [ADR 0021](./docs/adr/0021-a-retriever-says-whether-it-gives-scores-a-ranked-passage-has-none-and-a-scored-passage-always-has-one.md)). The name is coined: no leader names the unit of order only.
_Avoid_: Unscored passage, hit, rank (a position)

**Scored passage**:
A ranked passage with its score: `ScoredPassage<P> = RankedPassage<P> & { score }`, and the score is required. Every engine retriever, fusion, rerank retriever and embedding rerank retriever gives it. A scored passage is a ranked passage, so a scored list goes where an order is accepted. LlamaIndex calls it `NodeWithScore`, .NET `VectorSearchResult` ([ADR 0021](./docs/adr/0021-a-retriever-says-whether-it-gives-scores-a-ranked-passage-has-none-and-a-scored-passage-always-has-one.md)).
_Avoid_: Result, hit, match, search result

**Score threshold**:
The least score that a passage keeps. Only an object that knows the scale of its scores takes one: an embedding retriever and `EmbeddingRerankRetriever`, for the cosine similarity from -1 to 1, and `RerankRetriever`, for the score of its model. The scores of a keyword retriever and of a fusion change their scale with the engine and the query, so they take none ([ADR 0019](./docs/adr/0019-a-score-threshold-belongs-to-the-embedding-retriever-or-to-rerank-where-the-scale-of-the-score-is-known.md)). Qdrant and Haystack call it `score_threshold`, Elasticsearch's knn retriever `similarity`.
_Avoid_: Cutoff, similarity cutoff, minimum score

### Composition

**Fusion**:
The combination of several lists of ids into one scored list, best first: `Fusion<D>` with `fuse(inputs)`. It fuses ids, as Elasticsearch, OpenSearch and Qdrant do, and `FusionRetriever` gives each fused id its passage after. A fusion is a rank fusion or a score fusion ([ADR 0020](./docs/adr/0020-a-fusion-is-a-rank-fusion-or-a-score-fusion-over-ids-with-a-normalizer-for-each-list-and-a-combination.md)).
_Avoid_: Hybrid search (one use of fusion), ensemble, join, merge

**Fusion input**:
One list of a fusion, with its name and its weight: `FusionInput<D> = { name, docs, weight }`. Every error of the fusion names the input. A weight is a finite number of 0 or more, and at least one input has a weight above 0 (MongoDB `$rankFusion` and `$scoreFusion` take each pipeline by name with its weight).
_Avoid_: List (alone), source (a glossary word for the row key), pipeline

**Rank fusion**:
A fusion that reads the order of each list only: `RankFusion`, a rank normalizer for each list and a combination, after MongoDB's `$rankFusion`. With no options it is reciprocal rank fusion. It fuses a list of order only beside a scored one.
_Avoid_: Rank merge, RRF (for every rank fusion)

**Score fusion**:
A fusion that reads the scores of each list: `ScoreFusion`, a score normalizer for each list and a combination, both required, after MongoDB's `$scoreFusion`. Each input is scored, so a retriever of order only does not compile under it.
_Avoid_: Linear fusion, relative score fusion (one normalizer of it), convex combination

**Normalizer**:
The strategy that gives each item of one list its score before the combination. A rank normalizer reads the rank from 1 and the length of the list (`reciprocalRank`). A score normalizer reads the score and the statistics of its list, `ListScores { min, max, mean, std, l2 }` (`minMax`, `distributionBased`, `none`). Elasticsearch calls it `ScoreNormalizer`, OpenSearch a normalization technique. `ListScores` is a coined name: the leaders pass the whole list.
_Avoid_: Scaler, transform

**Combination**:
The strategy that joins the normalized scores of one id, each with the weight of its input, into its fused score: `sum` (CombSUM), `max` (CombMAX) or `arithmeticMean`. MongoDB calls it `combination`, OpenSearch a combination technique.
_Avoid_: Aggregation, merge function, reducer

**Reciprocal rank fusion**:
The rank fusion that gives each passage the sum of `weight / (k + rank)` over the lists that hold it, with k 60 and ranks from 1 (Cormack, Clarke and Büttcher, SIGIR 2009; [Elasticsearch rrf](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/rrf-retriever)). It is `new RankFusion()`, the default fusion of `FusionRetriever` and `MultiQueryRetriever`.
_Avoid_: RRF score (for the fused score), reciprocal rerank (LlamaIndex's name)

**Rank window**:
How many passages a fusion asks of each of its retrievers before it fuses. Elasticsearch calls it `rank_window_size`.
_Avoid_: Prefetch, candidate count, fetch-k

**Postprocessor**:
An object that changes a result list after the search: it cuts, diversifies, groups, reorders or widens the passages. LlamaIndex calls it `BaseNodePostprocessor`. `Postprocessor<P, I>` takes items of the kind `I` of passages `P` and gives back that kind: a postprocessor of order only does not go over a scored list. The package's postprocessors keep the kind they get, and `ContextWindow` needs stored passages of the metadata of its store ([ADR 0015](./docs/adr/0015-a-passage-is-typed-by-its-metadata-and-only-a-stored-passage-has-source-seq-start-and-end.md), [ADR 0021](./docs/adr/0021-a-retriever-says-whether-it-gives-scores-a-ranked-passage-has-none-and-a-scored-passage-always-has-one.md)).
_Avoid_: Compressor (LangChain), ranker (Haystack), filter (for a postprocessor)

**Rerank retriever**:
The retriever that scores the passages of its retriever again with an AI SDK reranking model and keeps the best `topN`: `RerankRetriever`, as Elasticsearch's `text_similarity_reranker` wraps a child retriever. Its retriever may give an order only; it gives scored passages ([ADR 0021](./docs/adr/0021-a-retriever-says-whether-it-gives-scores-a-ranked-passage-has-none-and-a-scored-passage-always-has-one.md)).
_Avoid_: Rerank postprocessor, cross-encoder (one kind of model), re-score

**Embedding rerank retriever**:
The retriever that scores the passages of its retriever again by meaning with an AI SDK embedding model when the query runs: `EmbeddingRerankRetriever`. It embeds the information need and the text of each passage, gives each passage the cosine similarity of the two vectors as its score and the vector the model made, and keeps the best `topN`. It is the reranker of a host with an embedding model and no reranking model, and of a live source, which has no stored vectors. LangChain's `EmbeddingsFilter` inside a `ContextualCompressionRetriever` does the same ([ADR 0022](./docs/adr/0022-a-reranker-may-embed-the-text-of-the-candidates-when-the-query-runs.md)).
_Avoid_: Embeddings filter (it does not only filter), bi-encoder reranker, semantic reranker
