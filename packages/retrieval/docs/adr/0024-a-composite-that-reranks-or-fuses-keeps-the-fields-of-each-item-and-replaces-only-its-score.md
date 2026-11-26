# A composite that reranks or fuses keeps the fields of each item and replaces only its score

Status: Accepted 2026-11-26 (backlog #5759).

Decision-makers: Ezz, who approved on 2026-11-26 the leaders paper of #5759 (`~/.agent-backlog/handoff/zukhruf-retrieval-collapse-members-5759/leaders-first-principles.md`, sources in `sources/` beside it): no collapse with members in the core, `Collapse` stays, and `RerankRetriever`, `EmbeddingRerankRetriever` and `FusionRetriever` keep each item's own fields and replace only its score, `Rescored<I>`. The zukhruf session that built it decided the shape of `Rescored` and the fused item type by the type probes below.

`RerankRetriever`, `EmbeddingRerankRetriever` and `fusePassages`, the core of `FusionRetriever` and `MultiQueryRetriever`, built each item again as `{ passage, score }` or `{ passage, score, vector }`. Any other field of the item was deleted: a highlight, an explanation, or the copies that a source's collapse hid. Meddit's DailyMed retriever collapses copies of a label section in its own SQL and gives, on each kept hit, the other labels of its group, as Elasticsearch's `inner_hits` sits on the hit; a rerank or a fusion over it would lose them.

The leaders keep the hit and change its score:

| Leader        | What a rerank or a fusion gives                                                                                   | Source (paper §2, §3.4, §3.5)                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Elasticsearch | rescore runs on the hits and changes their score; inner hits are not rescored; `rrf` keeps one document for an id | "Rescorers are not applied to inner hits" (`sources/es-collapse-search-results.txt:204`)          |
| OpenSearch    | the collapse processor runs after a rerank processor, on the same hits                                            | `sources/opensearch-collapse-processor.txt:1686`                                                  |
| Solr          | re-ranks the group heads after the collapse                                                                       | `sources/solr-query-re-ranking.txt:110`                                                           |
| LangChain     | its reranker copies the document and its metadata and adds `relevance_score`                                      | `sources/langchain-cohere-rerank.py:160-161`                                                      |
| LlamaIndex    | its reranker sets `node.score = score` on the same node; its fusion keeps a node object for each hash             | `sources/llamaindex-sentence-transformer-rerank.py`, `sources/llamaindex-fusion_retriever.py:131` |
| Haystack      | `DocumentJoiner` keeps "All other fields … from the first document received with that ID"                         | `sources/haystack-document-joiner.txt`                                                            |

Rerank: 3 of 3 engines and 2 of 2 frameworks keep the hit. Fusion: none merges the fields of two children's items for one id, and Haystack keeps the first document's.

Amends:

- [ADR 0007](./0007-reciprocal-rank-fusion-is-the-default-fusion-with-k-60-and-ranks-from-1.md), for the passage of a fused result: it is now the item of the first list that holds the id, with every field of that item.
- [ADR 0021](./0021-a-retriever-says-whether-it-gives-scores-a-ranked-passage-has-none-and-a-scored-passage-always-has-one.md), for what `RerankRetriever` gives: `Rescored<I>`, which is `ScoredPassage<P>` over a retriever of plain items.
- [ADR 0022](./0022-a-reranker-may-embed-the-text-of-the-candidates-when-the-query-runs.md), for what `EmbeddingRerankRetriever` gives: `Rescored<I>`.

## Decision

- **`Rescored<I>` is an item whose score a composite replaced.** It is exported beside `ScoredPassage`:

  ```ts
  type Rescored<I extends RankedPassage> = {
    [K in keyof I as Exclude<K, 'score' | 'vector'>]: I[K];
  } & {
    readonly score: number;
    readonly vector?: readonly number[];
  };
  ```

  - `score` is the composite's. `vector` is the composite's too: a rerank keeps the one its retriever gave, and a retriever gives one only when the call asks; `EmbeddingRerankRetriever` gives the one its model made, only when the call asks, and no other (ADR 0010); a fusion gives the first that a list gives (ADR 0007).
  - An item is plain data. The composites spread it, so its own enumerable fields are kept, and the methods and the prototype of a class item are not.
  - It is a mapped type over `keyof I`, not `Omit<I, 'score'>`. A mapped type over `keyof I` maps each member of a union on its own, so `Rescored<A | B>` is `Rescored<A> | Rescored<B>` and a reader narrows with `'innerHits' in item`. `Omit` keeps only the keys that every member has, so a fused union lost the field (the probe of `T1` below).
  - It names `vector` again, so `Rescored<I>` is a `RankedPassage<P>` for a generic `I`. Under `exactOptionalPropertyTypes`, `I['vector']` reads as `readonly number[] | undefined`, and the class did not implement `Retriever<Q, P, Rescored<I>>`.
  - `Rescored<RankedPassage<P>>` and `ScoredPassage<P>` are assignable both ways, so a caller that typed a composite's result as `ScoredPassage<P>` does not change.

- **`RerankRetriever<Q, P, I>` and `EmbeddingRerankRetriever<Q, P, I>`** take `retriever: Retriever<Q, P, I>` and implement `Retriever<Q, P, Rescored<I>>`, with `I = RankedPassage<P>` by default. `RerankRetriever` gives `{ ...item, score }`. `EmbeddingRerankRetriever` gives `{ ...item, score, vector }` when the call asks for vectors, and `{ ...item, score }` without the vector its retriever gave otherwise.
- **`FusionRetriever<Q, P, F, K, I>`** takes each retriever as `Retriever<Q, P, I & F>` and implements `Retriever<Q, P, Rescored<I>>`.
  - For an id that several retrievers give, the fused item is the item of the first retriever in the order of the record's keys, as the passage was (ADR 0007), with the fused score and the first vector that a retriever gives. No field of a later retriever's item is merged in: no leader merges members across children, and Elasticsearch's `rrf` keeps one document.
  - `I` is inferred from the items of the retrievers, as `P` is from their passages: the common item when one item is a supertype of the others, such as a ranked passage beside a scored one. Items that differ in fields of their own, such as a scored PubMed passage and a collapsed DailyMed hit, do not compile until the caller names their union, as two metadata types do not (ADR 0015).
  - The caller names the union by annotating one retriever as it (`const widened: Retriever<string, Passage, Item> = scored`): inference then gives `I = Item`, and `K` keeps the literal names, so an empty record and a name with `:` still do not compile. Type arguments would name it too, but TypeScript infers all of them or none, so `K` is then `string` and the name checks are off.
- **`I` is `out`** on the three classes. Unannotated, TypeScript 7 did not measure the variance of `Rescored<I>` and compared two `FusionRetriever`s by structure, where the method `retrieve` checks its parameter both ways, so a host fusion widened to a plain one (the two widening lines of `type-tests/published-types.ts` lost their errors).
- **`MultiQueryRetriever` keeps its type**, `ScoredPassage<P>`, over a `Retriever<QueryType, P, RankedPassage<P> & F>`. It calls the same `fusePassages`, so at run time its items keep their fields too; making its type generic waits for a consumer.
- **The postprocessors do not change.** `Collapse`, `LongContextReorder`, `MaximalMarginalRelevance` and `ContextWindow` filter, reorder or spread the items they get, so a `PostprocessingRetriever` around a rerank or a fusion keeps the fields.

## Considered Options

- **`Omit<I, 'score'> & { readonly score: number }`, the paper's sketch.** It does not map a union member by member, and its `vector` did not make it a `RankedPassage<P>` for a generic `I`.
- **Infer a union of the items of a fusion's retrievers**, with a record type parameter mapped per name. It would change the type parameters of `FusionRetriever` and how `Q`, `P` and `K` are inferred, which the published types pin. The rule for `P` already asks for a named union.
- **Merge the fields of every child's item for one id.** No leader does it.
- **A `CollapseRetriever` in the core** (the first paper). Withdrawn by the leaders paper: no leader builds members from a window of an earlier step.

## Consequences

- A host item with a field of its own keeps it under a rerank, a fusion and a `PostprocessingRetriever` around them, typed.
- The members a host item carries are not reranked, as Elasticsearch applies no rescorer to inner hits.
- A fusion of a host item beside a plain one infers the plain item, so the host field is on the items at run time and not in the type; the caller annotates one retriever as the union to read it.
- `EmbeddingRerankRetriever` deletes the vector its retriever gave from its copy of the item with `Reflect.deleteProperty`: a spread cannot leave out a key of a generic item, and `@zukhruf/eslint` forbids `as`.

## Confirmation

- `src/rerank-retriever.test.ts`, `src/embedding-rerank-retriever.test.ts` and `src/fusion-retriever.test.ts`, alone and under a `PostprocessingRetriever`: a host item keeps its field, its score is replaced, a rerank keeps the vector its retriever gave, an embedding rerank gives its model's vector only when asked, and a fusion keeps the first retriever's item for a shared id with no field of the later one merged in and the later vector when the first gives none. 13 mutations in memory are caught: the old rebuild in each class, the child's score kept, the vector rules, the last item kept and a merge of the later item.
- `type-tests/published-types.ts`, compiled against `dist` with TypeScript 7: `Rescored<RankedPassage<P>>` and `ScoredPassage<P>` both ways; a host field read after each composite and under a `ScoreFusion` and a `PostprocessingRetriever`; a fusion of a host item beside a plain engine has no host field (TS2339); a scored item beside a host item does not compile until the union is named (TS2322); with one retriever annotated as the union a reader narrows, and a name with `:` still does not compile (TS2322); a host `RerankRetriever` and `EmbeddingRerankRetriever` do not widen to plain ones (TS2322). Mutations of `dist` in memory caught: `Rescored` as `Omit` (T1) and each class giving `ScoredPassage<P>` again (T2 to T4).
