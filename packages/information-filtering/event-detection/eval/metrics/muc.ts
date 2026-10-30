import type { Contingency } from './contingency.ts';
import { type Score, ratio, score } from './f-measure.ts';

// MUC (Vilain et al. 1995, "A model-theoretic coreference scoring scheme").
// Recall: for each key entity K, |K| - |p(K)| correct links, where p(K) is
// the partition of K by the response, and each key mention that the
// response does not have is a part of its own; over sum |K| - 1. Precision is
// the same with key and response swapped. A singleton has no link, so MUC
// does not see singletons: a response that joins nothing scores 0.
export function muc(table: Contingency): Score {
  // |K| - |p(K)| = (mentions the response also has) - (response entities
  // that touch K); summed over K, it is the same count for both sides.
  const correct =
    table.keyShared.reduce((total, shared) => total + shared, 0) -
    table.cells.length;
  const links = (sizes: readonly number[]) =>
    sizes.reduce((total, size) => total + size - 1, 0);
  return score(
    ratio(correct, links(table.responseSizes)),
    ratio(correct, links(table.keySizes)),
  );
}
