import type { Passage } from './passage.ts';
import type { RankedPassage } from './ranked-passage.ts';

/**
 * A passage with its score: a finite number, higher is better (ADR 0005). A
 * scored passage is a ranked passage, so a scored list goes where an order
 * is accepted.
 */
export type ScoredPassage<P extends Passage = Passage> = RankedPassage<P> & {
  readonly score: number;
};

/**
 * An item whose score a composite replaced, as Elasticsearch's rescore keeps
 * the hit and LlamaIndex's reranker sets the score on the same node (ADR
 * 0024): every field of the item stays but `score`, which the composite
 * gives. `RerankRetriever` and a fusion keep the `vector` their retriever
 * gave, and a retriever gives one only when the call asks;
 * `EmbeddingRerankRetriever` gives its model's vector, only when the call
 * asks. So `Rescored<RankedPassage<P>>` is `ScoredPassage<P>`, and a host
 * item with a field of its own keeps it under a rerank or a fusion. A union
 * of items gives a union of rescored items, so a reader narrows by its field.
 *
 * An item is plain data: the composites spread it, so its own enumerable
 * fields are kept, and the methods and the prototype of a class item are not.
 */
export type Rescored<I extends RankedPassage> = {
  // A mapped type over `keyof I`, not `Omit`: it maps each member of a union
  // on its own, where `Omit` keeps only the keys that every member has.
  [K in keyof I as Exclude<K, 'score' | 'vector'>]: I[K];
} & {
  readonly score: number;
  readonly vector?: readonly number[];
};
