import { LeafMatches } from './leaf-matches.ts';

// A hit is a leaf pair with a value on both sides, whatever the two values
// (presence).
export class PathMatches extends LeafMatches {
  protected hit(): boolean {
    return true;
  }
}
