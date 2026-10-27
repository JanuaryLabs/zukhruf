import type { Contingency } from './contingency.ts';
import { type Score, ratio, score } from './f-measure.ts';
import { type Links, coreferenceLinks } from './links.ts';

// Pair (link) precision and recall: of the pairs of reports that the
// response joins, the share that the key joins too, and the reverse. It is
// the coreference part of BLANC.
export function pair(table: Contingency): Score {
  return linkScore(coreferenceLinks(table));
}

export function linkScore(links: Links): Score {
  return score(ratio(links.both, links.response), ratio(links.both, links.key));
}
