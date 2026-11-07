import gsumpw from '@stdlib/blas-ext-base-gsumpw';

import { Counts } from '../aggregation/counts.ts';
import type { Average, Classes } from './average.ts';

// average='micro': the counts of the selected classes are added, with numpy's
// pairwise sum, and scored once.
export class MicroAverage implements Average {
  of({ selected }: Classes, score: (counts: Counts) => number): number {
    const classes = [...selected.values()];
    const sum = (count: (counts: Counts) => number) =>
      gsumpw(classes.length, classes.map(count), 1);
    return score(
      new Counts({
        hits: sum(({ hits }) => hits),
        stated: sum(({ stated }) => stated),
        expected: sum(({ expected }) => expected),
      }),
    );
  }
}
