import { Counts } from '../../aggregation/counts.ts';
import type { Matches } from '../../scorers/matches.ts';
import type { Comparison } from '../comparison/comparison.ts';
import type { BothSides } from '../comparison/leaf-pair.ts';

// The options of the matches of leaves: with nullIsMissing, a null leaf is
// no value, on both sides.
export type LeafOptions = { readonly nullIsMissing?: boolean };

// The counts of the leaf pairs of one comparison: the stated leaves, the
// expected leaves, and the hits among the pairs with both sides. A subclass
// says only what a hit is (Template Method).
export abstract class LeafMatches implements Matches<Comparison> {
  readonly #nullIsMissing: boolean;

  constructor({ nullIsMissing = false }: LeafOptions = {}) {
    this.#nullIsMissing = nullIsMissing;
  }

  protected abstract hit(pair: BothSides): boolean;

  counts(comparison: Comparison): Counts {
    let hits = 0;
    let stated = 0;
    let expected = 0;
    for (const pair of comparison.leaves({
      nullIsMissing: this.#nullIsMissing,
    })) {
      if (pair.stated !== undefined) stated++;
      if (pair.expected === undefined) continue;
      expected++;
      if (pair.stated !== undefined && this.hit(pair)) hits++;
    }
    return new Counts({ hits, stated, expected });
  }
}
