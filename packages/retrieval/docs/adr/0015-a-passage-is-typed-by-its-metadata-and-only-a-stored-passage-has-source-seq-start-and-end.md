# A passage is typed by its metadata, and only a stored passage has source, seq, start and end

Status: Accepted 2026-11-25 (backlog #5584; paper #5638).

Decision-makers: Ezz, who approved the paper of #5638 on 2026-11-25 and accepted its one deviation from the leaders for this decision: "P (Retriever<in Q, P extends Passage>, StoredPassage keeps offsets through a fusion)". The leader tables of the paper decided the rest.

`Passage` required `source`, `seq`, `start` and `end`, so a live source filled them with made-up values: [ADR 0002](./0002-a-retriever-is-a-port-for-any-source.md) said to write `seq` 0. `metadata` was `Readonly<Record<string, unknown>>`, so a typo of a column compiled. The typed TypeScript leaders make the metadata a type parameter named `Metadata`: LangChain.js `Document<Metadata>` and LlamaIndex.TS `BaseNode<T extends Metadata>`. No leader puts offsets on every unit. LlamaIndex puts `start_char_idx` on `TextNode`, not on `BaseNode`, and makes it optional. .NET types the filter by its record (`Expression<Func<TRecord, bool>>`), and .NET's output is the whole record, `VectorSearchResult<TRecord>` (paper #5638, Q5, Q6).

Supersedes in part:

- [ADR 0001](./0001-the-package-is-the-query-side-of-rag-and-reads-a-passage-contract-that-elt-writes.md), for the type of a passage of the contract: `StoredPassage<M>`. Shipped.
- [ADR 0002](./0002-a-retriever-is-a-port-for-any-source.md), for its consequence "a host adapter fills `source`, `seq`, `start` and `end` as it can; a web result has one passage, `seq` 0". A live source gives `Passage<M>`. Shipped.
- [ADR 0009](./0009-a-filter-has-the-shape-of-haystacks-filters.md), for the type of a filter's field and value: `Filter<P>`. Shipped.
- [ADR 0013](./0013-a-query-is-a-string-or-a-query-bundle-with-a-text-for-each-kind-of-search.md), for its consequence "`Retriever<Q, M>`". The second parameter is the passage type `P`. Shipped.

## Decision

- `type Metadata = Readonly<Record<string, unknown>>`, `Passage<M> = { id, text, metadata: M }` and `StoredPassage<M> = Passage<M> & { source, seq, start, end }`.
- `Retriever<in Q, P extends Passage = Passage>` gives `ScoredPassage<P>`. `P` has no variance annotation on the port: the typed filter makes `out P` unprovable (TS2636), and the structural check of the port's function-typed `retrieve` is sound.
- Each composite class (`FusionRetriever`, `PostprocessingRetriever`, `HydeRetriever`, `MultiQueryRetriever`) declares `in out P`. TypeScript cannot measure the variance of `P` through the filter's mapped keys, so without an annotation it compares two composites by structure, where a class method checks its parameters both ways: a host-typed `FusionRetriever` widened to a plain one again, which `type-tests/published-types.ts` catches against `dist` (#5637). `in out` is the only annotation that holds, since `P` is in a parameter and in the result.
- `Filter<P>` names the stored fields of `P` and `metadata.<key>` of its metadata, each with its value type (`FilterFields<P>`). The default `Metadata` keeps any `metadata.<column>` with any value.
- Each passage store takes a required `metadata: (columns: Metadata) => M`, which reads the host's fields from the other columns of a row. Its engine retrievers give `StoredPassage<M>`.
- The ports `Postprocessor<in out P>` and `Fusion<in out P>` carry `P` in their parameter, and their members `postprocess` and `fuse` are not generic, because `@zukhruf/eslint`'s `island/no-generic-port` refuses a port that is generic in its response: a host's stub of a generic member would have to assert into `P`, and a stub of `Postprocessor<MyPassage>` asserts nothing. The package's postprocessors and fusions are implementations, not ports, so their members stay generic: each gives back the type it got. `ContextWindow` and `Collapse` take `P extends StoredPassage`; the others any `Passage`. `Collapse`'s default field `'source'` exists only for stored passages.
- The composites type their slots `Postprocessor<NoInfer<P>>` and `Fusion<NoInfer<P>>`, so `P` comes from the retrievers only. Without `NoInfer`, TypeScript (6 and 7) infers `P` from each `new Rerank(…)` as well, which is checked before `P` has a candidate, and `P` widens to `Passage`.

## Considered Options

- **`Retriever<Q, M>`, the majority (LangChain.js, LlamaIndex.TS) and ADR 0013's note.** It lost: a fusion of engines would give `Passage<M>`, and `ContextWindow` could not follow it (paper #5638, `probes/types-m-only.ts`).
- **Optional offsets, as LlamaIndex's `TextNode`.** It lost: an optional field that has no meaning for a live source is filler.
- **A filter key typed `string`, as LlamaIndex and Haystack.** It is kept as the default, and a declared `M` checks it.
- **An asserted `M` with no reader of the row, as LangChain.js's generic.** It lost: an `as` assertion of the rows, which `@zukhruf/eslint` refuses.
- **No variance annotation on the composite classes.** It lost: TypeScript then compares them by structure, and a class method's parameters check both ways.
- **`Postprocessor<in R>` with `postprocess<P extends R>(…)`, and `Fusion` with `fuse<P>(…)`.** It lost: `island/no-generic-port` refuses a port member that is generic in its response.
- **Built-ins generic in their class (`Rerank<P>`, `ContextWindow<P>`).** It lost: `new Rerank({ model })` in a composite's list takes its default `P` before the retriever's `P` is inferred, so the composite widens to `Passage` (TS2322 on the retriever, in TypeScript 6 and 7).

## Consequences

- A live source writes no `seq: 0`. `ContextWindow` over it does not compile.
- A fusion of a live source and an engine gives `Passage<M>`. A fusion of two metadata types names their union.
- A composite of stored passages is not assignable to the class type of a composite of plain passages; it is still a `Retriever` of plain passages, which is the type a host names.
- Every store constructor gains `metadata`. A host that wants the bag writes `(columns) => columns`.

## Confirmation

`type-tests/published-types.ts`, compiled against the built `dist` by `src/published-types.test.ts`, marks each error that the types must give, and the test asserts exactly those errors: a live retriever is not one of stored passages (TS2322); a retriever, and a `FusionRetriever`, whose metadata value is narrower is not one of a wider value (TS2322 twice); a typo of a metadata field (TS2551); a typo of a metadata column in a filter (TS2820); a value of the wrong type (TS2322); `seq` in the filter of a live passage (TS2322); `ContextWindow` over a live source and over a fusion of a live source and an engine (TS2322 twice); a fusion of a live source and an engine is no retriever of stored passages (TS2322); and two metadata types that fuse without a type argument (TS2322). The same file shows what compiles: an engine as a retriever of plain passages, any `metadata.<column>` on the default metadata, `ContextWindow` over an engine and over a fusion of engines, `Rerank` and `ContextWindow` over an engine and `reciprocalRankFusion()` over two engines with no type argument, and a host's `Postprocessor<StoredPassage<Label>>` and `Fusion<StoredPassage<Label>>` with no assertion.

Shipped so far (#5639, the types step): every type above, the composite classes' `in out P`, `ContextWindow` and `Collapse` as postprocessors of stored passages, and the engine retrievers and stores giving `StoredPassage` of the default metadata. The `metadata` reader of the stores, `Collapse<P>` and their tests come in the next step of #5639.
