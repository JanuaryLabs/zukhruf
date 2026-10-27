import { munkres } from 'munkres';

import type { Contingency } from './contingency.ts';
import { type Score, ratio, score } from './f-measure.ts';

// Entity-based CEAF, CEAF-e (Luo 2005, "On coreference resolution
// performance metrics"), with the similarity phi4(K, R) = 2 |K ∩ R| /
// (|K| + |R|). The optimal one-to-one alignment of key and response entities
// (Kuhn-Munkres) gives the largest sum of phi4; recall divides it by the
// number of key entities and precision by the number of response entities.
export function ceafE(table: Contingency): Score {
  const { keySizes, responseSizes } = table;
  // The cost is 1 - phi4, as in the reference scorer: an entity pair that
  // shares no mention costs 1.
  const cost = keySizes.map(() =>
    new Float64Array(responseSizes.length).fill(1),
  );
  for (const { key, response, count } of table.cells)
    cost[key]![response] =
      1 - phi4(count, keySizes[key]!, responseSizes[response]!);
  let similarity = 0;
  for (const [key, response] of munkres(cost, { finite: true }))
    similarity += 1 - cost[key]![response]!;
  return score(
    ratio(similarity, responseSizes.length),
    ratio(similarity, keySizes.length),
  );
}

function phi4(shared: number, key: number, response: number): number {
  return (2 * shared) / (key + response);
}
