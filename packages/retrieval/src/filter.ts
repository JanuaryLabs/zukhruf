/**
 * A condition on passage fields and metadata columns, in the shape of
 * Haystack's filters (ADR 0009). An engine retriever runs it as SQL `WHERE`.
 */
export type Filter =
  | {
      readonly operator: 'AND' | 'OR' | 'NOT';
      readonly conditions: readonly Filter[];
    }
  | {
      readonly field: 'source' | 'seq' | 'start' | 'end' | `metadata.${string}`;
      readonly operator:
        '==' | '!=' | '>' | '>=' | '<' | '<=' | 'in' | 'not in';
      readonly value: unknown;
    };
