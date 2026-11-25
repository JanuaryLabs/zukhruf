/** An item of a list of order only: its place in the list is its rank (MongoDB's "Ranked Pipeline"). */
export type RankedDoc = { readonly id: string };

/**
 * An item of a scored list (Lucene `ScoreDoc`): a ranked doc with its score.
 * An intersection, not a flat type, so TypeScript infers the fields of a
 * fusion besides the id from it.
 */
export type ScoreDoc = RankedDoc & { readonly score: number };

/**
 * One list of a fusion, with its name and weight, as MongoDB's `$rankFusion`
 * and `$scoreFusion` take each input pipeline by name with its weight.
 */
export type FusionInput<D extends RankedDoc> = {
  /** Names the input in every error. */
  readonly name: string;
  /** Best first for a rank fusion. A score fusion reads no order, except that ties keep first appearance. */
  readonly docs: readonly D[];
  /** A finite number of 0 or more; at least one input above 0 (ADR 0007, #5720). */
  readonly weight: number;
};

/**
 * Fuses lists of ids into one scored list, as Elasticsearch, OpenSearch and
 * Qdrant fuse ids and attach documents after. `in D`: a fusion of ranked
 * docs fuses scored docs too.
 */
export interface Fusion<in D extends RankedDoc> {
  /** Best first. Equal fused scores keep the order in which their ids first appear, in input order, then rank order. */
  readonly fuse: (inputs: readonly FusionInput<D>[]) => ScoreDoc[];
}
