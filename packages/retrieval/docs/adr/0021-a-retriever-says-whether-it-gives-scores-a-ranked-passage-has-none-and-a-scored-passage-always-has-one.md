# A retriever says whether it gives scores: a ranked passage has none, and a scored passage always has one

Amended on 2026-11-26 (#5759) for what `RerankRetriever` gives: `Rescored<I>`, the item of its retriever with the model's relevance as its score and every other field kept, which is `ScoredPassage<P>` over a retriever of plain items ([ADR 0024](./0024-a-composite-that-reranks-or-fuses-keeps-the-fields-of-each-item-and-replaces-only-its-score.md)).

Superseded in part on 2026-11-26 (#5728) for what `RerankRetriever` passes to its retriever and gives back. It takes `rankWindowSize`: its retriever gets the options of the call with the window as their `topK`, the `topK` of the call when absent, and the call gives the best `topK` of the reranked list. A `topN` that is not a positive integer is a `RangeError` ([ADR 0023](./0023-a-composite-that-fuses-reranks-or-diversifies-asks-its-retriever-for-a-rank-window-and-gives-the-topk-of-the-call.md)).

Status: Accepted 2026-11-26 (backlog #5400).

Decision-makers: Ezz, who set the direction on 2026-11-25 ("All of it, port split included"), against the leaders' optional score, and approved the paper of #5400 on 2026-11-26. On its split for the place of the reranker he chose `RerankRetriever`, a retriever around a retriever (option B), and he signed off the changed assertions of `Collapse`. The leader tables and the type probes of the paper (`~/.claude/plans/retrieval-fusion-families-5400.md`, probes in `retrieval-fusion-families-5400-probes/`) decided the rest.

[ADR 0016](./0016-a-scored-passage-may-have-no-score-and-a-list-is-in-the-retrievers-order.md) made `ScoredPassage.score` optional, so a live source of order only could give its list. But the field was filler: it had no meaning for a source of order only, and it was required in meaning for every engine. So the code checked `score === undefined` at run time, in `scoresOf` of the two score fusions and in `Collapse`, a route by data and not by type. A score fusion over a source of order only compiled and failed at run time with a `TypeError`. MongoDB refuses that case before it runs: `$scoreFusion` says "You must specify `$score` to the input pipeline if the input pipeline doesn't return a score" ([$scoreFusion](https://www.mongodb.com/docs/manual/reference/operator/aggregation/scoreFusion/)).

The leaders split on the place of a reranker. Elasticsearch reranks with a retriever, `text_similarity_reranker { retriever, rank_window_size, min_score }`, around a child retriever ([text similarity reranker](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/text-similarity-reranker-retriever)). LangChain wraps its base retriever in `ContextualCompressionRetriever { baseCompressor: CohereRerank, baseRetriever }`. LlamaIndex puts its rerankers in `node_postprocessors`, and Haystack puts its rankers in the pipeline graph after a retriever.

Supersedes:

- [ADR 0016](./0016-a-scored-passage-may-have-no-score-and-a-list-is-in-the-retrievers-order.md), in full. Its rules that stay are restated below: a list is best first, the place in the list is the rank, and a score is a finite number (#5700).
- [ADR 0002](./0002-a-retriever-is-a-port-for-any-source.md), in part, for the item of the port: `Retriever<Q, P, I>`.
- [ADR 0005](./0005-a-score-is-higher-for-a-better-passage.md), in part, for its line of 2026-11-25 that `ScoredPassage.score` is optional and that `Collapse` sorts by score.
- [ADR 0008](./0008-a-search-is-composed-of-retrievers-that-wrap-retrievers-and-a-list-of-postprocessors.md), in part, for `Rerank`, which is now `RerankRetriever`, the `Postprocessor` port, and `Collapse`, which keeps the order of the list (this replaces the sort of its amendment of 2026-11-23).
- [ADR 0015](./0015-a-passage-is-typed-by-its-metadata-and-only-a-stored-passage-has-source-seq-start-and-end.md), in part, for `Postprocessor<in out P>`, now `Postprocessor<P, I>`.
- [ADR 0019](./0019-a-score-threshold-belongs-to-the-embedding-retriever-or-to-rerank-where-the-scale-of-the-score-is-known.md), in part, for the class that takes the threshold of the reranking model: `RerankRetriever`.

## Decision

- **Two units.** `RankedPassage<P> = { passage, vector? }` is a passage in a list of order only: its place in the list is its rank. `ScoredPassage<P> = RankedPassage<P> & { score }`, and `score` is required: a finite number, higher for a better passage ([ADR 0005](./0005-a-score-is-higher-for-a-better-passage.md), #5700). A scored passage is a ranked passage. A list is best first.
- **One port with a third type parameter for the item.** `Retriever<in Q, P, out I extends RankedPassage<P> = RankedPassage<P>>`, with `RetrievalResult<P, I>` and `BatchRetriever<P, I>`. `I` is only in the result, so `out I` holds: a scored retriever goes where an order is accepted, and a ranked retriever is not a scored one (TS2322). `I`'s constraint names `P`, so an item of another passage type does not compile. The default keeps the meaning of every `Retriever<Q, P>` written before: it gives at least an order.
- **The engines give scored passages.** All six engine retrievers implement `Retriever<QueryType, StoredPassage<M>, ScoredPassage<StoredPassage<M>>>`, and the embedding ones `BatchRetriever` of the same item. `EngineScoredPassage` is gone: it existed only because `score` was optional.
- **The kind follows through each composite.** `FusionRetriever` and `MultiQueryRetriever` always give scored passages, the fused scores, and their retrievers follow the rule of the fusion ([ADR 0020](./0020-a-fusion-is-a-rank-fusion-or-a-score-fusion-over-ids-with-a-normalizer-for-each-list-and-a-combination.md)). `HydeRetriever<P, I>` gives the kind of its retriever.
- **The reranker is a retriever (option B).** `RerankRetriever<Q, P> { retriever, model, topN?, scoreThreshold? }` implements `Retriever<Q, P, ScoredPassage<P>>`. Its retriever may give an order only. It gives the relevance of the model as the score, best first, and drops a passage that the model leaves out or that is under the threshold. A relevance that is not finite is a `TypeError` (#5700). `Rerank` is gone, with no alias.
- **Postprocessors keep the kind.** `Postprocessor<in out P, in out I extends RankedPassage<P> = RankedPassage<P>>`, with `postprocess(passages: readonly I[], query, options?) => Promise<I[]>`. `PostprocessingRetriever<Q, P, I>` takes `retriever: Retriever<Q, P, I>` and `postprocessors: readonly Postprocessor<NoInfer<P>, NoInfer<I>>[]`, and gives `I`. The built-ins (`Collapse`, `MaximalMarginalRelevance`, `LongContextReorder`, `ContextWindow`) are generic in their method, `postprocess<I extends RankedPassage<P>>(…): Promise<I[]>`, so each serves either kind and gives back the kind it got. A host postprocessor of order only, such as a pin that adds a passage without a score, does not compile over a scored retriever: a scored list would then hold a passage without a score. The host types its retriever as `Retriever<Q, P>` first.
- **`Collapse` keeps the order of the list.** It keeps the first `size` passages of each value and reads no score. Elasticsearch's `collapse` keeps the top hit of each key in the order of the search's sort, and that order is the list here; Haystack's `MetaFieldGroupingRanker` keeps the input order inside a group. So `Collapse` after `MaximalMarginalRelevance` keeps the order of its picks. Its `TypeError` for a score that is not finite is gone.

## Considered Options

- **Keep `score?`, as five leaders do** (LlamaIndex `Optional[float]`, LlamaIndex.TS `score?`, Haystack `float | None`, .NET `double?`, Elasticsearch's field sort). It lost on Ezz's direction: the field is filler for a source of order only, and the code routed by it at run time.
- **Two port types, `Retriever` and `ScoredRetriever extends Retriever`.** It lost: it doubles `BatchRetriever` and `RetrievalResult`, and `HydeRetriever` and `PostprocessingRetriever` pass the kind through, so they need a kind parameter anyway.
- **The item as the only parameter, `Retriever<Q, I>`, with the passage `I['passage']`.** It lost: the filter reads `I` in a parameter, so `I` loses `out`, and every `Retriever<Q, StoredPassage<M>>` written before breaks.
- **A kind tag, `Retriever<Q, P, 'ranked' | 'scored'>`.** It lost: TypeScript cannot infer the tag back from an indexed access, so the composites lose the kind.
- **`Rerank` stays in the postprocessor list, and a type-level fold follows the kind (option A).** The leaders' majority shape (LlamaIndex, Haystack), and the probe checked every call site. It lost on Ezz's choice: the class needs two unchecked seams, an overload whose return differs from the implementation's and a bivariant step type, because `@zukhruf/eslint` forbids `as`.
- **One list typed `Postprocessor<P>[]`, with the kind of the retriever.** It lost: a live source with a reranker would type as ranked, so it could not go under a `ScoreFusion`.
- **A run-time flag on each postprocessor (`scores: true`), or a `pipe(a, b, c)` combinator.** The flag is a field that only the types read, a route by data. The combinator is called before the retriever is known, so `P` widens to `Passage`, as ADR 0015 found for class-generic built-ins.
- **`Collapse` sorts by score when the list is scored.** It lost: a generic `postprocess<I>` cannot take that branch by type without a run-time check, and the sort would still undo the picks of `MaximalMarginalRelevance`.

## Consequences

- A live source gives `RankedPassage<P>`. A `ScoreFusion` over it does not compile; a `RerankRetriever` around it gives scored passages, which go under a `ScoreFusion`.
- A host that wrote `score?.` reads `score` on a scored retriever, and nothing on a ranked one.
- A host's `PostprocessingRetriever` with `Rerank` in its list moves the reranker around its retriever: `new PostprocessingRetriever({ retriever: new RerankRetriever({ retriever, model }), postprocessors })`. #5586's `EmbeddingRerank` is a retriever too.
- `Collapse` over a list sorted best first gives the same passages as before; after `MaximalMarginalRelevance` it keeps the order of the picks. April's call, `Collapse` after a `FusionRetriever`, gives the same result, because the fused list is sorted.

## Confirmation

- `type-tests/published-types.ts`, compiled against `dist` with TypeScript 7 by `src/published-types.test.ts`, which asserts exactly its marked errors: a ranked retriever as a scored one (TS2322); a scored retriever as a ranked one compiles; a retriever of order only under a `ScoreFusion` in a `FusionRetriever` and in a `MultiQueryRetriever`, and a ranked doc in `ScoreFusion.fuse` (TS2322 each); a pin over a scored retriever and a scored-only postprocessor over a list of order only (TS2322 each); a `RerankRetriever` around a live source under a `ScoreFusion` compiles.
- `src/rerank-retriever.test.ts`: the tests of the old `Rerank`, moved, with a reranker over a retriever of order only giving scores.
- `src/collapse.test.ts`: `Collapse` keeps the first passage of each source in the order of the list, for a ranked and a scored list; `src/postprocessing-retriever.test.ts`: `Collapse` after `MaximalMarginalRelevance` keeps the order of its picks.
- The README's "Rerank and post-process the results" program gives the same output as before, with `RerankRetriever` around the fusion.
- The gate of the release: `retrieval:typecheck` green; `retrieval:test` 393 tests, 336 pass, 0 fail, 57 skipped.
