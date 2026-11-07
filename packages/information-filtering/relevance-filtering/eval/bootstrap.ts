import { defaultRng } from '@zukhruf/random';
import {
  ConfidenceInterval,
  IidBootstrap,
  Linear,
  PercentileInterval,
  mean,
} from '@zukhruf/statistics';

// A 95% percentile interval of a difference (Efron and Tibshirani 1993), and
// the difference that the data gives.
export class Interval extends ConfidenceInterval {
  readonly observed: number;

  constructor(observed: number, low: number, high: number) {
    super(low, high);
    this.observed = observed;
  }
}

const REPLICATES = 2000;

// numpy.percentile(replicates, [2.5, 97.5]), the default linear method.
const PERCENTILES = new PercentileInterval({
  low: 0.025,
  high: 0.975,
  method: new Linear(),
});

// The topic bootstrap of the research rounds (round-2 evaluate.py,
// topic_boot): each replicate draws as many profiles as there are, with
// replacement, and takes the mean of their differences.
export function topicBootstrap(
  differences: readonly number[],
  seed: number,
): Interval {
  const generator = defaultRng(seed);
  // integers(0, n, n) draws its n indices one at a time, so one index for
  // each call gives the same draws. integers(0, n, 1) always gives one.
  const bootstrap = new IidBootstrap({
    nResamples: REPLICATES,
    randomIndex: (n) => generator.integers(0, n, 1)[0] ?? Number.NaN,
  });
  const { low, high } = bootstrap.interval(differences, mean, PERCENTILES);
  return new Interval(mean(differences), low, high);
}

// The weights of the paired, label-stratified article bootstrap of the exam
// verdict rule: one weight for each exam article in each replicate, shared
// by every profile, N and list. The strata are the articles that are
// relevant to a profile of the verdict and the other articles, as in the
// round-1 bootstrap (relevant and not relevant), and each stratum draws as
// many articles as it holds, with replacement (README.md, "Exam").
export function articleWeights(
  relevantToAny: readonly boolean[],
  seed: number,
): number[][] {
  const generator = defaultRng(seed);
  const weights = Array.from({ length: REPLICATES }, () =>
    new Array<number>(relevantToAny.length).fill(0),
  );
  for (const inStratum of [true, false]) {
    const members = relevantToAny.flatMap((value, index) =>
      value === inStratum ? [index] : [],
    );
    const picks = generator.integers(
      0,
      members.length,
      REPLICATES * members.length,
    );
    for (const [replicate, row] of weights.entries())
      for (let draw = 0; draw < members.length; draw++) {
        const member = members[picks[replicate * members.length + draw] ?? 0];
        if (member !== undefined) row[member] = (row[member] ?? 0) + 1;
      }
  }
  return weights;
}

// The interval of (design - baseline) of a statistic that each replicate
// computes from its weights.
export function articleBootstrap(
  weights: readonly (readonly number[])[],
  observed: number,
  difference: (weights: readonly number[]) => number,
): Interval {
  const { low, high } = PERCENTILES.of(weights.map(difference));
  return new Interval(observed, low, high);
}
