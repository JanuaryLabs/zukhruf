import { sum } from '@zukhruf/statistics';

import { Counts } from '../aggregation/counts.ts';
import type { Average, Classes } from './average.ts';

// average='micro': the counts of the selected classes are added, with numpy's
// pairwise sum, and scored once.
export class MicroAverage implements Average {
  of({ selected }: Classes, score: (counts: Counts) => number): number {
    const classes = [...selected.values()];
    const total = (count: (counts: Counts) => number) =>
      sum(classes.map(count));
    return score(
      new Counts({
        hits: total(({ hits }) => hits),
        stated: total(({ stated }) => stated),
        expected: total(({ expected }) => expected),
      }),
    );
  }
}
