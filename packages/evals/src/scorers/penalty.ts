import { Ratio } from '../aggregation/ratio.ts';
import type { Scorer } from './scorer.ts';

// A factor in [0, 1] for one input, as BLEU's brevity penalty is: 1 is no
// penalty. Penalized multiplies the part of a scorer by it, for each record.
// A subclass gives the factor (Template Method). As a scorer, it gives the
// factor over 1.
export abstract class Penalty<Input> implements Scorer<Input> {
  abstract factor(input: Input): number;

  score(input: Input): Ratio {
    return new Ratio(this.factor(input), 1);
  }
}
