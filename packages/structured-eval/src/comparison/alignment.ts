import type { JsonData } from '@zukhruf/python';

// [stated index, expected index] for each pair.
export type Pairs = readonly (readonly [stated: number, expected: number])[];

// How many leaves of a stated item and an expected item agree. The walk gives
// it, so an alignment can prefer the pairing that agrees most.
export interface Agreement {
  count(stated: JsonData, expected: JsonData): number;
}

// Pairs the items of one array (Strategy).
export interface Alignment {
  pairs(
    stated: readonly JsonData[],
    expected: readonly JsonData[],
    agreement: Agreement,
  ): Pairs;
}
