# A composite that fuses, reranks or diversifies asks its retriever for a rank window and gives the topK of the call

Status: Accepted 2026-11-26 (backlog #5728).

Decision-makers: Ezz, who approved the paper on 2026-11-25 (`PostprocessingRetriever.rankWindowSize`, the cut to the `topK` of the call, the refusal when the call starts, the non-empty list of postprocessors), and the delta after #5400 that moved the rerank window onto `RerankRetriever` and `EmbeddingRerankRetriever` (meddit-86, 2026-11-26). The paper and its delta are in `~/.agent-backlog/handoff/zukhruf-retrieval-window-5728/paper.md`, with the leaders' sources in `sources/` and the probe of the gap in `probe-gap.mjs`.

`RerankRetriever` and `EmbeddingRerankRetriever` passed the options of the call to their retriever unchanged, and `PostprocessingRetriever` did the same. So a host could not ask its retriever for 500 candidates, rerank them and give the 10 of the call: a retriever that forced 50 gave the call 50 passages for a `topK` of 3, which breaks [ADR 0006](./0006-a-retriever-gives-10-passages-when-the-caller-gives-no-topk.md) (probe row 3). `MaximalMarginalRelevance` got the `topK` of the call and could only reorder those passages. Meddit's evidence search fetches 500 PubMed candidates, reranks them and gives the call's limit, and it could not move onto the package. Only `FusionRetriever` had the concept, as `rankWindowSize` ([ADR 0007](./0007-reciprocal-rank-fusion-is-the-default-fusion-with-k-60-and-ranks-from-1.md)).

The leaders whose stages nest and take a size with each request put the window on the node that reranks or diversifies a child, 5 of 5:

| Leader                                   | Node                          | Window                                                                                                                                                                                                                                                                 | Default | Window under the size                                                                                                                                                                        |
| ---------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Elasticsearch `text_similarity_reranker` | reranks a child retriever     | `rank_window_size`: "The number of top documents to consider in the re-ranking process" (`sources/es-text-similarity-reranker.md:62-65`)                                                                                                                               | 10      | refused, "requires [rank_window_size] be greater than or equal to [size]" (`sources/es-CompoundRetrieverBuilder.java:289-301`); a nested parent's window is at most its child's (`:316-327`) |
| Elasticsearch `diversify` (type `mmr`)   | diversifies a child retriever | `rank_window_size`: "The maximum number of top-documents the `diversify` retriever will receive from the inner retriever", beside its own `size` ([diversify retriever](https://www.elastic.co/docs/reference/elasticsearch/rest-apis/retrievers/diversify-retriever)) | 10      | a `CompoundRetrieverBuilder`, so refused as above                                                                                                                                            |
| Elasticsearch `rescorer`                 | rescores a child              | `window_size` (`sources/es-rescore.md:24-25`)                                                                                                                                                                                                                          | 10      | refused (`sources/es-retrievers-rescorer.txt`)                                                                                                                                               |
| Vespa second-phase and global-phase      | a phase of the rank profile   | `rerank-count`, per query `ranking.globalPhase.rerankCount` (`sources/vespa-phased-ranking.txt`, `sources/vespa-query-api-reference.txt`)                                                                                                                              | 100     | not refused                                                                                                                                                                                  |
| OpenSearch `rescore`                     | query rescorer                | `window_size` (`sources/os-rescore.txt`)                                                                                                                                                                                                                               | 10      | not refused                                                                                                                                                                                  |

The final limit is the size of the request, which the node applies after the window's stages. The libraries of pipeline objects (LlamaIndex `similarity_top_k` and `top_n`, Haystack retriever `top_k` and ranker `top_k`, LangChain `search_kwargs.k` and `top_n`) set both numbers on the instances, so the reranker's own limit is the final one, and no call can give its own. The package takes `topK` with each call (ADR 0006) and its composites nest, so it follows the engines.

Supersedes:

- [ADR 0007](./0007-reciprocal-rank-fusion-is-the-default-fusion-with-k-60-and-ranks-from-1.md), in part, for the place of the rank window: it is no longer the fusion's alone, and `FusionRetriever` now refuses a `rankWindowSize` that is not a positive integer when it is made.
- [ADR 0008](./0008-a-search-is-composed-of-retrievers-that-wrap-retrievers-and-a-list-of-postprocessors.md), in part, for what `PostprocessingRetriever` passes down and gives back.
- [ADR 0021](./0021-a-retriever-says-whether-it-gives-scores-a-ranked-passage-has-none-and-a-scored-passage-always-has-one.md), in part, for the options that `RerankRetriever` passes to its retriever, its cut to the `topK` of the call and its `topN`.
- [ADR 0022](./0022-a-reranker-may-embed-the-text-of-the-candidates-when-the-query-runs.md), in part, for the options that `EmbeddingRerankRetriever` passes to its retriever and its cut to the `topK` of the call.

## Decision

- **Four composites take `rankWindowSize`:** `FusionRetriever` (as before), `RerankRetriever`, `EmbeddingRerankRetriever` and `PostprocessingRetriever`, the node that runs `MaximalMarginalRelevance`. The name is Elasticsearch's and `FusionRetriever`'s.
- **The rule, the same in each.** The `topK` of the call is 10 when absent (ADR 0006). The window is `rankWindowSize`, or that `topK` when absent, so a composite without the option asks for what the call asks, and adding the option changes no existing call (Elasticsearch's default is 10). The retriever gets the options of the call with the window as their `topK`, so `filter`, `includeVectors` and `signal` reach it unchanged. The model or the postprocessors run on the whole window. The call gives the first `topK` of the result, always, with or without a window, so every composite keeps ADR 0006.
- **A window smaller than the `topK` of the call** is a `RangeError("The rankWindowSize ${window} is smaller than the topK ${topK} of the call")`, thrown before the retriever or the model is called, as Elasticsearch refuses it. The compiler cannot see it: `topK` comes with each call.
- **A `rankWindowSize` that is not a positive integer** (0, a negative, 2.5, NaN, Infinity) is a `RangeError("The rankWindowSize is a positive integer, not ${n}")` when the composite is made. Before, `FusionRetriever` took 2.5, NaN and Infinity silently and gave each to every retriever as its `topK`, and it refused 0 and a negative only per call, as a window smaller than the `topK` of the call; now `RankWindow` refuses all five when the `FusionRetriever` is made.
- **A `topK` of the call that is not a whole number of 0 or more** (a negative, 2.5, NaN, Infinity) is a `RangeError("The topK is a whole number of 0 or more, not ${topK}")`, thrown by `forCall` before the retriever or the model is called, as Elasticsearch refuses a bad `size`. A `topK` of 0 gives no passages, as `size` 0 does. `forCall` is the one entry of the call's `topK` into the four composites, and the cut is `slice(0, topK)`, so without the check a `topK` of -1 with a window of 50 gave 49 passages, NaN gave none and 2.5 reached the retriever; `FusionRetriever` before passed each of them to every retriever. The composites check the call's `topK` now; the engine retrievers do not yet, and wait for #5772.
- **One Value Object.** The rule is one piece of knowledge in four places (strike 3), so it is `RankWindow` in `src/rank-window.ts`, which the package does not export: `RankWindow.of(rankWindowSize)` checks the option when the composite is made, and `forCall(topK)` gives the `topK` and the window of a call or the `RangeError`.
- **`PostprocessingRetriever` takes a window only with at least one postprocessor.** A window with none would fetch passages only to cut them, so its options are a union: with a `rankWindowSize`, `postprocessors` is a non-empty tuple, and `postprocessors: []` does not compile; without one, an empty list compiles as before.
- **`topN` stays.** Inside a window it is not needed: the composite cuts to `topK`, as `text_similarity_reranker` does. A `topN` below `topK` gives fewer passages, as Cohere's `top_n` does. `RerankRetriever` now refuses a `topN` that is not a positive integer with a `RangeError`, as `EmbeddingRerankRetriever` does: the AI SDK passed 0, 2.5 and NaN to the provider unchecked.
- **`scoreThreshold` in a window** keeps the passages at or above it among the whole window, then the cut applies, as Elasticsearch's `min_score` inside `rank_window_size`.
- **Nesting needs no new code.** A composite with a window of 50 over a `FusionRetriever` with a window of 20 gets the fusion's `RangeError`, which is Elasticsearch's nested rule. A host screen that must run on the passages the call gives, such as a retraction screen, goes in an outer `PostprocessingRetriever` with no window:

```ts
new PostprocessingRetriever({
  retriever: new EmbeddingRerankRetriever({
    retriever: pubmed,
    model,
    rankWindowSize: 500,
  }),
  postprocessors: [retractionScreen], // runs on the topK passages only
});
```

## Considered Options

- **The window on `PostprocessingRetriever` only**, the paper of 2026-11-25. Since #5400 the reranker is a retriever around a retriever, not a postprocessor, so the rerank window moved onto the node that reranks, as `text_similarity_reranker` holds it. `PostprocessingRetriever` keeps its window for `MaximalMarginalRelevance`, as Elasticsearch's `diversify` holds one.
- **A window per call, as Vespa's `ranking.globalPhase.rerankCount`.** 1 of 5 leaders, and only as an override of the rank profile's value. A call's options reach every retriever below it, so a per-call window would reach each nested reranker too.
- **Elasticsearch's default of 10.** It would change every existing call that asks for more than 10: `FusionRetriever` already defaults to the `topK` of the call (ADR 0007).
- **Take a window under the `topK`, as Vespa and OpenSearch do.** The call would give fewer passages than it asked for with no error. The package already refused it in `FusionRetriever`.
- **A ledger for the copies (strike 2)**, as the paper counted with two places. With the two rerankers the rule is in four, so it is extracted.

## Consequences

- Retrieve-then-rerank is one composite: `new RerankRetriever({ retriever, model, rankWindowSize: 500 })` gives the call's `topK` of the best of 500.
- Every composite now gives at most the `topK` of the call: `RerankRetriever`, `EmbeddingRerankRetriever` and `PostprocessingRetriever` did not cut before, so a host retriever or a host postprocessor that gave more than `topK` passed them all on.
- Every composite now gives its retriever an explicit `topK`, 10 when the call gives none.
- A composite that adds a window later uses `RankWindow` and joins the tables of `src/rank-window.test.ts`.

## Confirmation

- `src/rank-window.test.ts`, over `RerankRetriever`, `EmbeddingRerankRetriever` and `PostprocessingRetriever`: with a window of 50 and a `topK` of 3 the retriever gets 50 and the other options unchanged, the model ranks the 50 and the call gives the best 3, the best from position 40; with no window the retriever gets the `topK` of the call, or 10; a window of 5 for a `topK` of 6 is the `RangeError` before any call, and 6 is taken; a window of 50 over a `FusionRetriever` of 20 is the fusion's `RangeError`, and over one of 100 each child gets 100; a retriever that gives more than `topK` still leaves the call with `topK`. For the two rerankers, `scoreThreshold` and `topN` in a window. For the four composites, `FusionRetriever` included, 0, -1, 2.5, NaN and Infinity are a `RangeError` when it is made.
- `src/postprocessing-retriever.test.ts`: `MaximalMarginalRelevance` in a window picks a passage that lies past the `topK` in the search's order, and a host postprocessor that gives more passages than it got leaves the call with `topK`. `src/rerank-retriever.test.ts`: a `topN` of 0, -1, 1.5, NaN or Infinity is a `RangeError`.
- `type-tests/published-types.ts`: a `rankWindowSize` with `postprocessors: []` does not compile.
- Each test failed first on an assertion, and each rule is caught by a mutation in memory: the check of the option, `<=` for `<`, the default of 10, the window passed down, the cut skipped, the cut moved before the postprocessors and the check moved after the retriever.
