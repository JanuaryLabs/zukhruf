import type { LeafValue } from './leaf-pair.ts';

// Says if a stated leaf and an expected leaf of one field agree (Strategy).
// The walk asks it only for a leaf pair with both sides.
export interface Comparator {
  agrees(stated: LeafValue, expected: LeafValue): boolean;
}
