import { sum } from '@zukhruf/statistics';

import { Counts } from '../aggregation/counts.ts';
import type { Average, Classes } from './average.ts';

// average='micro': the counts of the classes are added, with numpy's
// pairwise sum, and scored once.
export class MicroAverage implements Average {
  of(classes: Classes, score: (counts: Counts) => number): number {
    const each = [...classes.counts.values()];
    const total = (count: (counts: Counts) => number) => sum(each.map(count));
    return score(
      new Counts({
        hits: total(({ hits }) => hits),
        stated: total(({ stated }) => stated),
        expected: total(({ expected }) => expected),
      }),
    );
  }
}
