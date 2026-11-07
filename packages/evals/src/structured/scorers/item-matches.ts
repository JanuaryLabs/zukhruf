import { Counts } from '../../aggregation/counts.ts';
import type { Comparison } from '../comparison/comparison.ts';
import type { Matches } from './matches.ts';

// The items of every array of one comparison: a hit is a pair that the
// alignment of its array made, of the stated items and the expected items.
export class ItemMatches implements Matches {
  counts(comparison: Comparison): Counts {
    let hits = 0;
    let stated = 0;
    let expected = 0;
    for (const items of comparison.arrays()) {
      hits += items.paired;
      stated += items.stated;
      expected += items.expected;
    }
    return new Counts({ hits, stated, expected });
  }
}
