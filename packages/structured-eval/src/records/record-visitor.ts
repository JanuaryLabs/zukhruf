// A value that the walk reached in the expected record, the stated record or
// both. `agrees` is true when both have a value and the comparator of the
// field says they agree.
export type Leaf = {
  readonly field: string;
  readonly path: string;
  readonly expected: unknown;
  readonly stated: unknown;
  readonly agrees: boolean;
};

// The items of one array and how many of them the alignment paired.
export type Items = {
  readonly field: string;
  readonly expected: number;
  readonly stated: number;
  readonly paired: number;
};

// Receives what the walk of two records reaches.
export interface RecordVisitor {
  leaf?(leaf: Leaf): void;
  items?(items: Items): void;
}
