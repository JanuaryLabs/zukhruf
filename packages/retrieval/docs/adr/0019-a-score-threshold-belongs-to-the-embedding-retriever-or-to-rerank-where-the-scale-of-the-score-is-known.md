# A score threshold belongs to the embedding retriever or to Rerank, where the scale of the score is known

Superseded in part on 2026-11-26 (#5586) for the places that take the threshold. `EmbeddingRerankRetriever` takes `scoreThreshold` too, on the cosine similarity from -1 to 1, so the threshold is in three places, and the finite check and the cut are one Value Object, `ScoreThreshold`, which the embedding retrievers, `RerankRetriever` and `EmbeddingRerankRetriever` use; the two copies of #5735 are gone ([ADR 0022](./0022-a-reranker-may-embed-the-text-of-the-candidates-when-the-query-runs.md)).

Superseded in part on 2026-11-26 (#5400) for the class that takes the threshold of a reranking model. `Rerank` is `RerankRetriever`, a retriever around a retriever, and it takes `scoreThreshold` as `Rerank` did. `EngineScoredPassage` is gone: every engine retriever gives `ScoredPassage`, whose score is required ([ADR 0021](./0021-a-retriever-says-whether-it-gives-scores-a-ranked-passage-has-none-and-a-scored-passage-always-has-one.md)).

Status: Accepted 2026-11-25 (backlog #5734).

Decision-makers: the zukhruf session mutex-63, from the leaders (four of five) and the probes of #5734. Ezz agreed on 2026-11-25 when he picked the option "Embedding retrievers and Rerank take scoreThreshold. SimilarityCutoff goes": "first option".

`SimilarityCutoff` compared one threshold with the score of any step before it. [ADR 0005](./0005-a-score-is-higher-for-a-better-passage.md) made every score higher for a better passage, but it did not put the scores on one scale. Its consequence "`SimilarityCutoff` keeps the passages with `score >= threshold` for every retriever" took the direction for the scale. Each step has its own scale:

- An embedding retriever gives the cosine similarity, from -1 to 1. A vector opposite to the query scores -1 on SQLite and on SQL Server 2025 (17.0.5065.9).
- The SQLite keyword retriever gives the negated `bm25()`, which has no upper bound: 1.918 for "backup mailbox" over the passages of the README.
- The SQL Server keyword retriever gives the `RANK` of `CONTAINSTABLE`, "a value (from 0 through 1000)" ([CONTAINSTABLE](https://learn.microsoft.com/en-us/sql/relational-databases/system-functions/containstable-transact-sql), Remarks). The same passage and query got 64, and the AND query of the same words got 48.
- Reciprocal rank fusion of two lists gives about 0.016 to 0.033.
- `Rerank` gives the score of its reranking model.

One threshold, 0.2, kept 3 of 3 passages after the embedding retriever, 2 of 2 after the keyword retriever, 0 of 3 after reciprocal rank fusion and 1 of 3 after relative score fusion. After reciprocal rank fusion the list was empty, and no error came back.

The leaders put a threshold on a step whose scale is known:

- Qdrant: `score_threshold` of a search. It "may exclude lower or higher scores depending on the used metric" ([search](https://qdrant.tech/documentation/search/search/), "Filtering Results by Score").
- Elasticsearch: `similarity` of the knn retriever, "the minimum similarity required for a document to be considered a match" ([knn retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/knn-retriever)).
- LangChain: the search type `similarity_score_threshold` with `score_threshold` ([base.py](https://raw.githubusercontent.com/langchain-ai/langchain/master/libs/core/langchain_core/vectorstores/base.py)).
- Haystack: `score_threshold` of its rankers, "to return documents with a score above this threshold only", applied after the ranking and before `top_k` (haystack-core-integrations `sentence_transformers_similarity.py:57,95,304`, `jina/ranker.py:38`).

LlamaIndex alone compares its `similarity_cutoff` with any score: `SimilarityPostprocessor` reads `node.score`, whatever retriever made it (`llama_index/core/postprocessor/node.py`). `SimilarityCutoff` copied it.

## Decision

- `SqliteEmbeddingRetriever`, `PgvectorEmbeddingRetriever` and `SqlServerEmbeddingRetriever` take `scoreThreshold` in their constructor. Each list of `retrieve` and `retrieveMany` keeps the passages whose score is equal to or more than it, best first.
- `Rerank` takes `scoreThreshold`. It keeps the passages whose score from the reranking model is equal to or more than it.
- A `scoreThreshold` that is not a finite number is a `RangeError` when the object is made.
- `SimilarityCutoff` is gone. A keyword retriever, a fusion and a retriever of a host take no threshold from the package. A host that knows the scale of its own scores writes its own postprocessor.
- The embedding retrievers apply the threshold after the search of the engine, to the score that the caller gets, in the search step that the three engines share. A cut of the first `topK` passages gives the passages that a cut before `topK` gives, because the list is best first: 7 of 7 probes agreed, also with equal scores at the edge.

## Considered Options

- **Keep `SimilarityCutoff`, and give the scale of each step in the README**, the shape of LlamaIndex. It lost: a `SimilarityCutoff` after a fusion or a keyword retriever still empties a list with no error.
- **A `scoreThreshold` in `RetrieveOptions`, for each call, as Qdrant takes it for each search.** It lost: a `FusionRetriever` gives the options of the call to every retriever in it, also a key that the retriever does not know, so the threshold would reach the keyword retrievers. In the constructor, the threshold stays with the retriever that knows the scale.
- **A bound on the distance in the SQL of each engine**, `distance <= 1 - t`. It lost: it is three copies of one rule, and in floating point it can disagree with the score that the caller sees. `distance <= 1 - t` and `1 - distance >= t` gave different answers in 3 of 24 random cases.

## Consequences

- A host that used `SimilarityCutoff` after an embedding retriever or after `Rerank` moves the threshold into that object, and gets the same passages. No repo outside zukhruf used `SimilarityCutoff` (`git grep -wF` over the repos, 2026-11-25).
- A threshold after a keyword retriever or a fusion is not possible: the scale of such a score changes with the engine and with the query.
- The rule of [ADR 0016](./0016-a-scored-passage-may-have-no-score-and-a-list-is-in-the-retrievers-order.md) that `SimilarityCutoff` drops a passage without a score goes with it. Both new places always give a score: the search of an engine gives an `EngineScoredPassage`, whose score is required.
- A list that the threshold cuts can have fewer passages than `topK`.
- The finite check and the cut are in two places, the shared search of the embedding retrievers and `Rerank`. They are strike 2 of the Rule of Three ([copied code](../copied-code.md), #5735).

## Confirmation

- Red, then green: `a scoreThreshold of NaN, Infinity or -Infinity is a RangeError` for the SQLite retriever and for `Rerank`; `retrieve with a scoreThreshold of 0.5 or 0 keeps the passages whose score is at least the threshold` and `retrieveMany with a scoreThreshold cuts the list of each query` on SQLite; `a Rerank keeps the passages whose score from the reranking model is at least the threshold` with three cases. Green on arrival, because the option was passed on for the build: the Postgres test, and the SQL Server test, which runs on CI only and skips on arm64 (#5469).
- Mutations, each in memory, each caught: no finite check (both places), no cut, `>` for `>=` (both places), the cut skipped for `retrieveMany` or for each list after the first, a check for a threshold of 0 (`!scoreThreshold`), `Rerank` reading the old score, and the Postgres retriever not passing the option on. Not proven by a mutant: the SQL Server test (arm64) and the type claims (`thresholds` and `perCall` in `type-tests/published-types.ts`), which compile against `dist` with TypeScript 7.
- Probes: `~/.agent-backlog/handoff/zukhruf-retrieval-score-threshold/probes/` (`cutoff.ts`, `probes.ts`, `sqlserver-probes.ts`, `equivalence.ts`).
