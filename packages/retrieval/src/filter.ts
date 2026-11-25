import type { Passage } from './passage.ts';

type StoredField = 'source' | 'seq' | 'start' | 'end';

/**
 * The fields that a filter can name on a passage type, with their value
 * types: the stored fields that `P` has, and `metadata.<key>` of its metadata
 * (ADR 0015). The default metadata gives any `metadata.<column>` with any
 * value.
 */
export type FilterFields<P extends Passage> = {
  readonly [F in keyof P & StoredField]: P[F];
} & {
  readonly [
    K in keyof P['metadata'] & string as `metadata.${K}`
  ]: P['metadata'][K];
};

type Comparison<P extends Passage> = {
  [F in keyof FilterFields<P>]:
    | {
        readonly field: F;
        readonly operator: '==' | '!=' | '>' | '>=' | '<' | '<=';
        readonly value: FilterFields<P>[F] | null;
      }
    | {
        readonly field: F;
        readonly operator: 'in' | 'not in';
        readonly value: readonly FilterFields<P>[F][];
      };
}[keyof FilterFields<P>];

/**
 * A condition on passage fields and metadata columns, in the shape of
 * Haystack's filters (ADR 0009), with the fields and values of the passage
 * type (ADR 0015). An engine retriever runs it as SQL `WHERE`.
 */
export type Filter<P extends Passage = Passage> =
  | {
      readonly operator: 'AND' | 'OR' | 'NOT';
      readonly conditions: readonly Filter<P>[];
    }
  | Comparison<P>;
