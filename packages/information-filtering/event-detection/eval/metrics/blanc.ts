import type { Contingency } from './contingency.ts';
import type { Score } from './f-measure.ts';
import { coreferenceLinks, nonCoreferenceLinks } from './links.ts';
import { linkScore } from './pair.ts';

// BLANC (Recasens and Hovy 2011, "BLANC: Implementing the Rand index for
// coreference evaluation"), in the form of Luo et al. 2014 ("An extension of
// BLANC to system mentions"), which the reference scorer v8 implements. It
// scores the coreference links and the non-coreference links apart and
// averages the two: P and R are the means of the two P and R, and each F is
// the mean of the two F. When the key has no coreference link (each event a
// singleton), BLANC is the non-coreference score alone, and the reverse.
export function blanc(table: Contingency): Score {
  const coreference = coreferenceLinks(table);
  const nonCoreference = nonCoreferenceLinks(table);
  const c = linkScore(coreference);
  const n = linkScore(nonCoreference);
  if (coreference.key === 0 && nonCoreference.key === 0)
    return { precision: 0, recall: 0, f1: 0, f05: 0 };
  if (coreference.key === 0) return n;
  if (nonCoreference.key === 0) return c;
  return {
    precision: (c.precision + n.precision) / 2,
    recall: (c.recall + n.recall) / 2,
    f1: (c.f1 + n.f1) / 2,
    f05: (c.f05 + n.f05) / 2,
  };
}
