import type { FilterFields } from './filter.ts';
import type { Passage, StoredPassage } from './passage.ts';
import type { RankedPassage } from './ranked-passage.ts';

/** A passage field or `metadata.<key>` of the passage type, as in a filter. */
type FieldOf<P extends Passage> = keyof FilterFields<P> & string;

type Options<F extends string> = {
  /** A passage field or `metadata.<key>` of the passage type, as in a filter. */
  readonly field: F;
  /** How many passages each value keeps: 1 when absent. */
  readonly size?: number;
};

/**
 * The options of a Collapse of `P`. A stored passage has a source, so the
 * field is `'source'` when absent: the passages of one document. A live
 * passage has none, so its field is required (ADR 0015).
 */
type Arguments<P extends Passage, F extends string> = [P] extends [
  StoredPassage,
]
  ? [options?: Partial<Options<F>>]
  : [options: Options<F>];

/**
 * Keeps the first `size` passages of each value of a field, in the order of
 * the list, as Elasticsearch's `collapse` keeps the top hit of each key in
 * the order of the search's sort and Vespa's `collapsesize` keeps that many
 * (ADR 0008). A list is best first, so the first passages of a value are its
 * best; it reads no score, so it keeps the order of a postprocessor before
 * it, such as the picks of `MaximalMarginalRelevance`, and serves a list of
 * order only as a scored one (#5400). The field is a passage field or
 * `metadata.<key>` of the passage type, as in a filter, so a field that the
 * passages lack does not compile: neither in the constructor with a type
 * argument `P`, nor in `postprocess`, which takes only passages that have the
 * field `F` (ADR 0015). The passages without a value for the field (absent
 * or null) are one group, as Elasticsearch groups a missing value under the
 * key null (ADR 0008, the proposed amendment of 2026-11-23).
 *
 * A Collapse is a `Postprocessor<P>` for every passage type that has its
 * field, but it declares no `implements`: TypeScript defers the check of `F`
 * against the passages inside the class (type-tests/published-types.ts proves
 * the assignment).
 */
export class Collapse<
  P extends Passage = StoredPassage,
  F extends FieldOf<P> = FieldOf<P>,
> {
  readonly #field: string;
  readonly #size: number;

  // `NoInfer`: TypeScript cannot read `P` back from a field name, so `P` is
  // the type argument, or `StoredPassage` when there is none; `F` is the
  // field as written.
  constructor(...[options]: Arguments<NoInfer<P>, F>) {
    this.#field = options?.field ?? 'source';
    this.#size = options?.size ?? 1;
  }

  async postprocess<I extends RankedPassage<P>>(
    passages: readonly I[] &
      (F extends FieldOf<I['passage']> ? unknown : never),
    _query?: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<I[]> {
    options.signal?.throwIfAborted();
    const kept = new Map<unknown, number>();
    return passages.filter(({ passage }) => {
      const key = this.#value(passage) ?? null;
      const count = kept.get(key) ?? 0;
      kept.set(key, count + 1);
      return count < this.#size;
    });
  }

  #value(passage: Passage): unknown {
    const field = this.#field;
    // A stored field is a field of the passage; a passage type without it
    // gives no such field to the constructor.
    const fields: Readonly<Record<string, unknown>> = passage;
    return field === 'source' ||
      field === 'seq' ||
      field === 'start' ||
      field === 'end'
      ? fields[field]
      : passage.metadata[field.slice('metadata.'.length)];
  }
}
