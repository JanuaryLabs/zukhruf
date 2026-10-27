import type { Contingency } from './contingency.ts';
import { type Score, ratio, score } from './f-measure.ts';

// B-cubed (Bagga and Baldwin 1998, "Algorithms for scoring coreference
// chains"), with equal weight for each mention. For a mention m, precision
// is |K(m) ∩ R(m)| / |R(m)| and recall is |K(m) ∩ R(m)| / |K(m)|; precision
// averages over the response mentions and recall over the key mentions. A
// response that joins nothing has a precision of 1, so B-cubed rewards it on
// a set of mostly singleton events (Moosavi and Strube 2016).
export function bCubed(table: Contingency): Score {
  let precision = 0;
  let recall = 0;
  for (const { key, response, count } of table.cells) {
    precision += count ** 2 / table.responseSizes[response]!;
    recall += count ** 2 / table.keySizes[key]!;
  }
  const mentions = (sizes: readonly number[]) =>
    sizes.reduce((total, size) => total + size, 0);
  return score(
    ratio(precision, mentions(table.responseSizes)),
    ratio(recall, mentions(table.keySizes)),
  );
}
