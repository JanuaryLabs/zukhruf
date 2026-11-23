import type { Filter } from './filter.ts';
import type { Postprocessor } from './postprocessor.ts';
import type { ScoredPassage } from './scored-passage.ts';

type Field = Extract<Filter, { readonly field: string }>['field'];

/**
 * Keeps the best `size` passages of each value of a field, best first, as
 * Elasticsearch's `collapse` keeps the top hit of each key and Vespa's
 * `collapsesize` keeps that many (ADR 0008). The field is a passage field or
 * `metadata.<column>`, as in a filter. Equal scores keep the order of the
 * list. The passages without a value for the field (absent or null) are one
 * group, as Elasticsearch groups a missing value under the key null (ADR
 * 0008, the proposed amendment of 2026-11-23).
 */
export class Collapse implements Postprocessor {
  readonly #field: Field;
  readonly #size: number;

  constructor(
    options: {
      /** `'source'` when absent: the passages of one document. */
      readonly field?: Field;
      /** How many passages each value keeps: 1 when absent. */
      readonly size?: number;
    } = {},
  ) {
    this.#field = options.field ?? 'source';
    this.#size = options.size ?? 1;
  }

  async postprocess(
    passages: readonly ScoredPassage[],
  ): Promise<ScoredPassage[]> {
    const kept = new Map<unknown, number>();
    return passages
      .toSorted((a, b) => b.score - a.score)
      .filter(({ passage }) => {
        const key = this.#value(passage) ?? null;
        const count = kept.get(key) ?? 0;
        kept.set(key, count + 1);
        return count < this.#size;
      });
  }

  #value(passage: ScoredPassage['passage']): unknown {
    const field = this.#field;
    return field === 'source' ||
      field === 'seq' ||
      field === 'start' ||
      field === 'end'
      ? passage[field]
      : passage.metadata[field.slice('metadata.'.length)];
  }
}
