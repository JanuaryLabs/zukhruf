import type { BothSides } from '../comparison/leaf-pair.ts';
import { LeafMatches } from './leaf-matches.ts';

// A hit is a leaf pair whose two values agree, as the comparator of its field
// in the spec of the walk says.
export class ValueMatches extends LeafMatches {
  protected hit(pair: BothSides): boolean {
    return pair.agrees;
  }
}
