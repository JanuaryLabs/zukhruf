import { mean } from './metrics.ts';
import { NumpyGenerator } from './numpy-random.ts';

// A 95% percentile interval of a difference (Efron and Tibshirani 1993).
export type Interval = {
  readonly observed: number;
  readonly low: number;
  readonly high: number;
};

const REPLICATES = 2000;

// numpy.percentile with its default linear interpolation, on sorted values.
export function percentile(sorted: readonly number[], q: number): number {
  const position = ((sorted.length - 1) * q) / 100;
  const below = Math.floor(position);
  const a = sorted[below] ?? Number.NaN;
  const b = sorted[Math.min(below + 1, sorted.length - 1)] ?? Number.NaN;
  const t = position - below;
  const difference = b - a;
  return t >= 0.5 ? b - difference * (1 - t) : a + difference * t;
}

// The topic bootstrap of the research rounds (round-2 evaluate.py,
// topic_boot): each replicate draws as many profiles as there are, with
// replacement, and takes the mean of their differences.
export function topicBootstrap(
  differences: readonly number[],
  seed: number,
): Interval {
  const generator = new NumpyGenerator(seed);
  const replicates = Array.from({ length: REPLICATES }, () =>
    mean(
      generator
        .integers(0, differences.length, differences.length)
        .map((index) => differences[index] ?? Number.NaN),
    ),
  ).toSorted((a, b) => a - b);
  return {
    observed: mean(differences),
    low: percentile(replicates, 2.5),
    high: percentile(replicates, 97.5),
  };
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
  const generator = new NumpyGenerator(seed);
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
  const replicates = weights.map(difference).toSorted((a, b) => a - b);
  return {
    observed,
    low: percentile(replicates, 2.5),
    high: percentile(replicates, 97.5),
  };
}
