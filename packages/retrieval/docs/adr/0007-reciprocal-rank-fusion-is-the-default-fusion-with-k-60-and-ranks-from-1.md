# Reciprocal rank fusion is the default fusion, with k 60 and ranks from 1

Superseded in part on 2026-11-25 (#5583) for a list without scores. Reciprocal rank fusion reads the order only, so such a list fuses like any other; `relativeScoreFusion` and `distributionBasedScoreFusion` refuse a passage without a score with a `TypeError` that names the passage and its list, and says to fuse a list of order only with `reciprocalRankFusion` ([ADR 0016](./0016-a-scored-passage-may-have-no-score-and-a-list-is-in-the-retrievers-order.md)).

Superseded in part on 2026-11-25 (#5582) for the retrievers and the weights of `FusionRetriever`: a record by name, with weights by name and 1 for each name that is absent, so a count of weights that differs from the count of retrievers cannot be written. The `RangeError` for weights that are not one for each list stays for `Fusion.fuse` ([ADR 0014](./0014-a-retrieve-call-answers-with-the-retrievers-that-answered-and-names-those-that-were-unavailable.md)).

Status: accepted by Ezz on 2026-11-23 ("Approve, write the paper").

Reciprocal rank fusion (RRF; Cormack, Clarke and Büttcher, SIGIR 2009) gives each passage the sum of `weight / (k + rank)` over the lists that hold it. The leaders agree on k 60 with ranks from 1:

- Elasticsearch `rrf`: `rank_constant` 60, `rank_window_size` 10, a `weight` of 1.0 for each retriever ([rrf retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/rrf-retriever)).
- LangChain `EnsembleRetriever`: `c` 60, ranks from 1, equal weights ([ensemble.ts](https://raw.githubusercontent.com/langchain-ai/langchainjs/main/libs/langchain-classic/src/retrievers/ensemble.ts)).
- LlamaIndex `QueryFusionRetriever`: k 60, ranks from 0 ([fusion_retriever.py](https://raw.githubusercontent.com/run-llama/llama_index/main/llama-index-core/llama_index/core/retrievers/fusion_retriever.py)).
- Haystack: k 61, "60 was suggested by the original paper, plus 1 as python lists are 0-based" ([misc.py](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/utils/misc.py)). So Haystack's 61 is the same fusion as 60 with ranks from 1.
- OpenSearch, Vespa, Chroma, LanceDB and Alex Garcia's SQLite recipe use 60 ([score ranker](https://docs.opensearch.org/latest/search-plugins/search-pipelines/score-ranker-processor/), [Vespa phased ranking](https://docs.vespa.ai/en/ranking/phased-ranking.html), [Chroma hybrid](https://docs.trychroma.com/cloud/search-api/hybrid-search), [LanceDB reranking](https://docs.lancedb.com/reranking), `RRFReranker` K 60, [Garcia](https://alexgarcia.xyz/blog/2024/sqlite-vec-hybrid-search/index.html)).
- Qdrant is the outlier: its `rrf` k is "set to 2 by default" ([hybrid queries](https://qdrant.tech/documentation/concepts/hybrid-queries/)).

Two score fusions also exist: min-max scaling (Weaviate `relativeScoreFusion`, the hybrid default since 1.24, [Weaviate hybrid](https://docs.weaviate.io/weaviate/search/hybrid); LlamaIndex `relative_score`; OpenSearch `min_max`, [normalization processor](https://docs.opensearch.org/latest/search-plugins/search-pipelines/normalization-processor/)) and mean ± 3σ scaling (Qdrant `dbsf`, LlamaIndex `dist_based_score`, Haystack `distribution_based_rank_fusion`, [document_joiner.py](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/components/joiners/document_joiner.py)).

## Decision

- `FusionRetriever { retrievers, fusion, weights, rankWindowSize }` calls each retriever with `rankWindowSize` as its `topK`, fuses the lists on `Passage.id` and gives the best `topK`.
- `fusion` defaults to `reciprocalRankFusion({ k: 60 })`, with ranks from 1.
- `weights` default to 1 for each retriever.
- `rankWindowSize` defaults to the `topK` of the call. Elasticsearch's `rank_window_size` defaults to 10, the default `size` of a search, and must be greater than or equal to `size` ([rrf retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/rrf-retriever)).
- `relativeScoreFusion()` (min-max) and `distributionBasedScoreFusion()` (mean ± 3σ) are the other two fusions.

## Considered Options

- **Haystack's k 61 with ranks from 0.** It lost only on the form: it gives the same scores, and ranks from 1 match the paper, Elasticsearch and LangChain.
- **Qdrant's k 2.** It lost: no other leader uses it, and a small k gives the first ranks much more weight than the paper's 60.
- **A score fusion as the default, as Weaviate and OpenSearch have.** It lost: RRF needs no common scale, and most leaders default to it.

## Consequences

- `@zukhruf/mteb`'s `HybridSearch` (`fuseRrf`, `rsf`, `dbsf`) and datahub's staff search (#3426) are the other two places of fusion (strike 3, #5399, #5400). mteb keeps its MTEB port.

## Amendment 2026-11-23, proposed

Accepted by Ezz on 2026-11-23: "0.5, as Qdrant" for a list with no spread, "First list (as built)" for the passage that two lists hold, and "They stand" for the rest. The paper does not fix these details of the three fusions, and the leaders disagree on them. Each rule below is the one of most of the cited leaders, read in their source on 2026-11-23. LangChain is `ensemble.ts`, LlamaIndex `fusion_retriever.py`, Haystack `utils/misc.py` (RRF) and `components/joiners/document_joiner.py` (DBSF), Qdrant `lib/segment/src/common/score_fusion.rs`, Weaviate `usecases/traverser/hybrid/hybrid_fusion.go`, and OpenSearch `MinMaxScoreNormalizer.java` and `ArithmeticMeanScoreCombinationTechnique.java` of neural-search.

- **A passage that a list does not hold adds nothing from that list, and the contributions of a passage are added.** RSF: Weaviate adds (lines 137-146), LlamaIndex adds (lines 199-209); OpenSearch takes the weighted mean over the sub-queries that have a score (`combine`, lines 43-59). DBSF: Qdrant adds (lines 75-86), LlamaIndex adds; Haystack keeps the highest score (`_concatenate`, lines 208-219, called on line 312).
- **The weights multiply the contributions as given.** Elasticsearch, LangChain (line 86), Haystack (misc.py line 201), Qdrant (lines 66-72) and Weaviate (line 129) use the weight as given; LlamaIndex divides each weight by their sum and by `num_queries` (lines 57-61, 192-196); OpenSearch divides by the sum of the weights.
- **RSF gives 1 to each passage of a list whose scores are all equal.** Weaviate gives the weight, that is 1 times the weight (lines 131-135); OpenSearch gives 1.0 (`calculateNormalizedScore`, lines 69-71); LlamaIndex gives 1.0 when the score is above 0 and 0.0 otherwise (lines 183-184).
- **DBSF takes the population standard deviation (`std` of `@zukhruf/statistics` with `ddof` 0).** LlamaIndex (lines 168-171) and Haystack (lines 297-298) divide by n; Qdrant takes the sample variance, divided by n - 1 (line 142).
- **DBSF does not clip a score to [0, 1].** None of Qdrant (lines 97-108), LlamaIndex (lines 186-188) and Haystack (line 308) clips. MTEB's port in `@zukhruf/mteb` (`hybrid-wrappers.ts`) clips, but it is not a cited leader.
- **DBSF gives 0.5 to each passage of a list with a standard deviation of 0, and to the passage of a list of one.** The leaders split three ways: Qdrant gives 0.5 (lines 97-102 and 150-153); LlamaIndex gives 1.0 or 0.0 by the sign of the score; Haystack keeps the score of the retriever (lines 302-309). Qdrant's 0.5 is chosen with no majority: it is the value that the formula gives to the mean, and it keeps the scores of every list on one scale. Haystack's rule mixes the scale of the retriever into the fused scores.
- **The passage of a fused result is the one of the first list that holds its id, and its vector the first that a list gives.** The leaders split: LangChain (lines 103-116), Qdrant (`or_insert`, line 82) and LlamaIndex's RSF and DBSF (lines 205-209) keep the first; LlamaIndex's RRF (line 132), Haystack's RRF (misc.py line 202) and Weaviate (lines 54 and 146) keep the last. The first is chosen so that one rule holds for every fusion and agrees with the order of ties below. For the vector, Haystack's `_merge_embeddings` keeps the first embedding that a document has (document_joiner.py lines 241-265), so a keyword list without vectors does not take the vector of a passage away from the fused result.
- **Equal fused scores keep the order in which their ids first appear, in the order of the lists and then of the ranks.** LangChain sorts its first-seen union with a stable sort (lines 95-98); LlamaIndex and Haystack sort a dict in the order of first insertion with Python's stable `sorted`. Weaviate breaks a tie by the retriever's score and then by id (lines 155-166).
- **A fusion refuses weights that are not one for each list, with a `RangeError`.** LangChain throws (lines 71-75) and Haystack's `zip(..., strict=True)` raises (misc.py line 199); Qdrant gives a weight of 1 to each list past its weights (line 57).
- **`FusionRetriever` refuses a `rankWindowSize` smaller than the `topK` of the call, with a `RangeError`**, as Elasticsearch refuses a `rank_window_size` smaller than `size` ([rrf retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/rrf-retriever)).

## Amendment 2026-11-25: a weight is a finite number of 0 or more, and k is an integer of 1 or more

Accepted 2026-11-25 (#5720). Decision-makers: the zukhruf session mutex-63, from the leaders. Ezz gave the go: "start make sure to reproduce any bugs or claim using /tdd or /write-test skills also make sure we build strict software and learn from top leaders".

A weight and `k` went into the sums with no check. A weight of NaN gave the passages of its list the score NaN, and reciprocal rank fusion put them first. A weight of Infinity gave Infinity. A weight of -1 turned its list upside down. Weights that were all 0 gave every passage the score 0. A `k` of NaN gave NaN, and a `k` of -1 gave Infinity at rank 1. No error came back.

- **A weight is a finite number of 0 or more, and when there is a list, at least one weight is above 0.** Else a `RangeError` names the weight and its list, or its retriever. Haystack's `DocumentJoiner` refuses a weight that is not finite or that is below 0, and weights whose sum is 0, in its `__init__` ([document_joiner.py](https://raw.githubusercontent.com/deepset-ai/haystack/main/haystack/components/joiners/document_joiner.py)). The `weight` of Elasticsearch's rrf retriever "Must be non-negative", and of its linear retriever "Must be greater or equal to 0" ([rrf retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/rrf-retriever), [linear retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/linear-retriever)). OpenSearch takes weights from 0.0 to 1.0 whose sum is 1.0 ([normalization processor](https://docs.opensearch.org/latest/search-plugins/search-pipelines/normalization-processor/)). LangChain's `EnsembleRetriever` says "At least one ensemble weight must be greater than zero" (`ensemble.py`, lines 98-100). Qdrant alone gives a weight of 0 or less no part, with no error (`reciprocal_rank_fusion.rs`, lines 32-38). A weight of 0 stays: its list adds nothing to a score.
- **One check, where the weights enter.** `FusionRetriever` refuses its weights when it is made, as Haystack's joiner refuses them in `__init__`. `fuse` refuses the weights of a call, for a host that calls a fusion itself. Both call `checkWeights` of `src/sum-on-id.ts`.
- **`FusionRetriever` gives the fusion one list for each retriever**, an empty list for a retriever that did not answer, with the weights that its constructor checked. An empty list adds nothing in any of the three fusions. Before, the fusion got only the lists and the weights of the retrievers that answered. With the new check, a retriever of weight 0 that answered beside an unavailable retriever of weight 1 would have turned the unavailable retriever into a `RangeError`.
- **`k` is an integer of 1 or more**, as Elasticsearch's `rank_constant` is ("(Optional, integer)", "greater than or equal to 1"). Else `reciprocalRankFusion` throws a `RangeError` when it is made. Qdrant takes an integer of 0 or more.
- **The weights are not scaled to a sum of 1**, as Haystack and OpenSearch scale them. Scaling changes the scores and not the order, and the weights multiply as given (the Decision above).

Confirmation: the tests of #5720 in `src/fusion.test.ts` and `src/fusion-retriever.test.ts` failed before the change, with no `RangeError`. The test of an unavailable retriever of weight 1 passed before the change, failed after the check went into `fuse`, and passed again when `FusionRetriever` gave one list for each retriever. Each of the 14 mutations of the rules was caught in memory, the two halves of each check among them.
