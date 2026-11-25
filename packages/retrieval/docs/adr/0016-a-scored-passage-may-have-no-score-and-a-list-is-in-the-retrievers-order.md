# A scored passage may have no score, and a list is in the retriever's order

Status: Accepted 2026-11-25 (backlog #5583; paper #5638).

Decision-makers: Ezz, who approved the paper of #5638 on 2026-11-25 and chose, against the leaders' majority: "a missing score in rsf/dbsf throws a TypeError naming reciprocalRankFusion". The leader tables of the paper decided the rest.

A live source can give an order and no score, such as a web search or PubMed's Best Match. `ScoredPassage.score` was required, so such a source made up scores, and `relativeScoreFusion` and `distributionBasedScoreFusion` gave `NaN` to a list without them and put those passages above the scored list (#5583). Seven of nine leaders can give a hit without a score. Five of them make the score optional: LlamaIndex `Optional[float]`, LlamaIndex.TS `score?`, Haystack `float | None`, .NET `double?`, and Elasticsearch's field sort, which computes no score. LangChain.js and Semantic Kernel carry no score. No leader uses a union of a rank and a score (paper #5638, Q3, Q4).

Supersedes in part:

- [ADR 0005](./0005-a-score-is-higher-for-a-better-passage.md), for "`ScoredPassage.score` … for every retriever" and "a result list is sorted by score". The direction, higher for a better passage, stays. Shipped for the type.
- [ADR 0007](./0007-reciprocal-rank-fusion-is-the-default-fusion-with-k-60-and-ranks-from-1.md), for rsf and dbsf over a list without scores. Shipped.
- [ADR 0008](./0008-a-search-is-composed-of-retrievers-that-wrap-retrievers-and-a-list-of-postprocessors.md), for `SimilarityCutoff` and `Collapse`. Shipped.

## Decision

- `ScoredPassage<P> = { passage, score?, vector? }`. A retriever that gives an order only writes no score, and its list is in its own order. A list is best first: by score when the retriever gives scores, otherwise in the retriever's order. The place in the list is the rank.
- `reciprocalRankFusion` reads the order only, so a list without scores fuses like any other. `relativeScoreFusion` and `distributionBasedScoreFusion` throw a `TypeError` for a passage without a score, which names the passage and the list and says to fuse a list of order only with `reciprocalRankFusion`. Composing a score fusion over a source of order only is a caller bug, and a bug rejects.
- `SimilarityCutoff` drops a passage without a score, as LlamaIndex's `SimilarityPostprocessor` does. `Collapse` sorts by score when every passage has one, and otherwise keeps the order. `Rerank` gives every passage a score. `MaximalMarginalRelevance`, `LongContextReorder` and `ContextWindow` keep each passage's score, or its absence.

## Considered Options

- **`{ kind: 'rank', rank } | { kind: 'score', score }`** (Meddit ADR 0002). It lost: no leader has it, and a rank field can disagree with the place in the list.
- **A missing score is 0 in a score fusion, as LlamaIndex, Haystack and Eino do.** It lost, by Ezz's choice: it ties every passage of the list without scores with the best scored passage (paper #5638, `probes/run-rank-only.out`: rsf gives `p1:1.000 p2:1.000 p3:1.000 l1:1.000 l2:0.000`).
- **A scorer id beside the score** (Meddit). It lost: no leader has one, and a host that knows two lists share a scorer writes its own `Fusion<P>` for its passage type, with no assertion (ADR 0015).

## Confirmation

`probes/run-rank-only.out` and `probes/types-fusion.ts` of paper #5638 (a live source with no score compiles). `type-tests/published-types.ts` has a live source whose passage has no score, and it compiles against `dist`.

Shipped (#5639): the optional `score` in the types step; the rest in the scores step. Every retriever of the package still writes a score; a host's live source may write none. The fusion tests show `reciprocalRankFusion` fusing a list of order only beside a scored list by their order, and `relativeScoreFusion` and `distributionBasedScoreFusion` refusing it with the `TypeError`, directly and through a `FusionRetriever` over a SQLite keyword search, where they gave `NaN` scores ranked above the scored list (#5583). The postprocessor tests show `SimilarityCutoff` dropping a passage without a score under any threshold, `Collapse` keeping the order of a list with one passage unscored and sorting a list scored throughout, and `Rerank` scoring every passage of a list of order only.
