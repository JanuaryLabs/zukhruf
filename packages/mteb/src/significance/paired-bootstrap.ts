import { compareStrings } from '@zukhruf/python';
import { defaultRng } from '@zukhruf/random';
import {
  IidBootstrap,
  Linear,
  PercentileInterval,
  mean,
} from '@zukhruf/statistics';

// Not from MTEB: MTEB has no significance test.

// The verdict of a paired bootstrap test on a change and its baseline.
// observed is the mean of (change - baseline) over the queries, and low and
// high are the bounds of its 95% percentile interval. p is the two-sided
// percentile-bootstrap p-value of the same replicates.
export type ChangeVerdict = {
  readonly result: 'better' | 'worse' | 'inconclusive';
  readonly observed: number;
  readonly low: number;
  readonly high: number;
  readonly p: number;
  readonly queries: number;
  readonly replicates: number;
  readonly seed: number;
};

const REPLICATES = 2000;
const SEED = 31957;

// np.percentile(means, [2.5, 97.5]), the default linear method.
const PERCENTILES = new PercentileInterval({
  low: 0.025,
  high: 0.975,
  method: new Linear(),
});

// The level at or below which a deciding p-value counts.
const ALPHA = 0.05;

// The result of a test from the p-value that decides it: a difference counts
// when p is at most 0.05, as a level-0.05 test rejects (Casella and Berger
// 2002, Definition 8.3.26; the rule of Holm of @zukhruf/statistics), and its
// sign says better or worse.
export const decide = (
  p: number,
  observed: number,
): ChangeVerdict['result'] => {
  if (p > ALPHA) return 'inconclusive';
  return observed > 0 ? 'better' : 'worse';
};

// The paired bootstrap test over queries (Efron and Tibshirani 1993; Sakai
// 2006 for retrieval): each replicate draws as many queries as there are,
// with replacement, and takes the mean of their differences. p is twice the
// smaller share of replicate means at or below 0 and at or above 0, at most
// 1, and the result is decide(p, observed). With 2000 replicates, the 95%
// interval lies beyond 0 when p is below 0.05 and reaches 0 when p is above
// it; at p = 0.05 exactly (50 of 2000 on one side) its bound interpolates
// between the 50th and 51st means, one on each side of 0, so it can lie
// beyond 0 or reach it. The result follows p, not the interval, and a
// report decides by the same p. The differences are in the order of the
// sorted query ids, and the replicates are those of
// numpy.random.default_rng(seed).
export function pairedBootstrapTest(
  baseline: ReadonlyMap<string, number>,
  change: ReadonlyMap<string, number>,
  options: { readonly replicates?: number; readonly seed?: number } = {},
): ChangeVerdict {
  const { replicates = REPLICATES, seed = SEED } = options;
  const queries = [...baseline.keys()].sort(compareStrings);
  const unpaired = [
    ...queries.filter((query) => !change.has(query)),
    ...[...change.keys()].filter((query) => !baseline.has(query)),
  ];
  if (unpaired.length > 0)
    throw new RangeError(
      `A paired test needs the same queries in the baseline and the change. Not in both: ${unpaired.join(', ')}`,
    );
  const differences = queries.map(
    (query) =>
      (change.get(query) ?? Number.NaN) - (baseline.get(query) ?? Number.NaN),
  );
  const generator = defaultRng(seed);
  // integers(0, n, n) draws its n indices one at a time, so one index for
  // each call gives the same draws. integers(0, n, 1) always gives one.
  const means = new IidBootstrap({
    nResamples: replicates,
    randomIndex: (n) => generator.integers(0, n, 1)[0] ?? Number.NaN,
  }).distribution(differences, mean);
  const interval = PERCENTILES.of(means);
  const share = (side: (value: number) => boolean) =>
    means.filter(side).length / means.length;
  const p = Math.min(
    1,
    2 *
      Math.min(
        share((value) => value <= 0),
        share((value) => value >= 0),
      ),
  );
  const observed = mean(differences);
  return {
    result: decide(p, observed),
    observed,
    low: interval.low,
    high: interval.high,
    p,
    queries: queries.length,
    replicates,
    seed,
  };
}
