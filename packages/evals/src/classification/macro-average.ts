import { sum } from '@zukhruf/statistics';

import type { Counts } from '../aggregation/counts.ts';
import type { Average, Classes } from './average.ts';

// average='macro': the mean of the scores of the classes, as
// numpy's nanmean gives it: a NaN score (zeroDivision NaN) adds 0 and is not
// counted, and the mean of no score is NaN.
export class MacroAverage implements Average {
  of(classes: Classes, score: (counts: Counts) => number): number {
    const scores = [...classes.counts.values()].map(score);
    const counted = scores.filter((value) => !Number.isNaN(value)).length;
    if (counted === 0) return Number.NaN;
    const values = scores.map((value) => (Number.isNaN(value) ? 0 : value));
    return sum(values) / counted;
  }
}
