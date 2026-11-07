import { sum } from '@zukhruf/statistics';

import type { Counts } from '../aggregation/counts.ts';
import type { Average, Classes } from './average.ts';

// average='weighted': the mean of the scores of the selected classes, each
// weighted by its true count, as scikit-learn's _nanaverage gives it: a NaN
// score is dropped with its weight, the mean of no score is NaN, and when the
// weights add up to 0 it is the plain mean.
export class WeightedAverage implements Average {
  of({ selected }: Classes, score: (counts: Counts) => number): number {
    const kept = [...selected.values()]
      .map((counts) => ({ value: score(counts), weight: counts.expected }))
      .filter(({ value }) => !Number.isNaN(value));
    if (kept.length === 0) return Number.NaN;
    const weights = sum(kept.map(({ weight }) => weight));
    if (weights === 0) return sum(kept.map(({ value }) => value)) / kept.length;
    return sum(kept.map(({ value, weight }) => value * weight)) / weights;
  }
}
