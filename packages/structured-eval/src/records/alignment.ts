// [stated index, expected index] for each pair.
export type Pairs = readonly (readonly [stated: number, expected: number])[];

// How many fields of a stated item and an expected item agree. The walk gives
// it, so an alignment can prefer the pairing that agrees most.
export interface Agreement {
  count(stated: unknown, expected: unknown): number;
}

// Pairs the items of one array.
export interface Alignment {
  pairs(
    stated: readonly unknown[],
    expected: readonly unknown[],
    agreement: Agreement,
  ): Pairs;
}
