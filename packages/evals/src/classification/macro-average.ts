import { nanmean } from '@zukhruf/statistics';

import type { Counts } from '../aggregation/counts.ts';
import type { Average, Classes } from './average.ts';

// average='macro': the mean of the scores of the classes, as
// numpy's nanmean gives it: a NaN score (zeroDivision NaN) adds 0 and is not
// counted, and the mean of no score is NaN.
export class MacroAverage implements Average {
  of(classes: Classes, score: (counts: Counts) => number): number {
    return nanmean([...classes.counts.values()].map(score));
  }
}
