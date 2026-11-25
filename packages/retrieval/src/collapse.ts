import type { FilterFields } from './filter.ts';
import type { Passage, StoredPassage } from './passage.ts';
import type { ScoredPassage } from './scored-passage.ts';

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
 * Keeps the best `size` passages of each value of a field, best first, as
 * Elasticsearch's `collapse` keeps the top hit of each key and Vespa's
 * `collapsesize` keeps that many (ADR 0008). The field is a passage field or
 * `metadata.<key>` of the passage type, as in a filter, so a field that the
 * passages lack does not compile: neither in the constructor with a type
 * argument `P`, nor in `postprocess`, which takes only passages that have the
 * field `F` (ADR 0015). Equal scores keep the order of the list. The passages
 * without a value for the field (absent or null) are one group, as
 * Elasticsearch groups a missing value under the key null (ADR 0008, the
 * proposed amendment of 2026-11-23).
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

  async postprocess<R extends P>(
    passages: readonly ScoredPassage<R>[] &
      (F extends FieldOf<R> ? unknown : never),
  ): Promise<ScoredPassage<R>[]> {
    const kept = new Map<unknown, number>();
    return passages
      .toSorted((a, b) => (b.score ?? Number.NaN) - (a.score ?? Number.NaN))
      .filter(({ passage }) => {
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
