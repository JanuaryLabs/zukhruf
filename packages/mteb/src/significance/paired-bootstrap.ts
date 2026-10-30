import { NumpyGenerator } from '../dependencies/numpy-random.ts';
import { mean, percentile } from '../dependencies/numpy.ts';
import { compareStrings } from '../dependencies/python.ts';

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

// The paired bootstrap test over queries (Efron and Tibshirani 1993; Sakai
// 2006 for retrieval): each replicate draws as many queries as there are,
// with replacement, and takes the mean of their differences. The change is
// better when the whole interval is above 0, worse when it is below 0, and
// inconclusive else. p is twice the smaller share of replicate means at or
// below 0 and at or above 0, at most 1, so p < 0.05 agrees with the 95%
// interval but for its interpolation. The differences are in the order of the sorted query
// ids, and the replicates are those of numpy.random.default_rng(seed).
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
  const generator = new NumpyGenerator(seed);
  const means = Array.from({ length: replicates }, () =>
    mean(
      generator
        .integers(0, differences.length, differences.length)
        .map((index) => differences[index] ?? Number.NaN),
    ),
  ).toSorted((a, b) => a - b);
  const low = percentile(means, 2.5);
  const high = percentile(means, 97.5);
  const share = (side: (value: number) => boolean) =>
    means.filter(side).length / replicates;
  const p = Math.min(
    1,
    2 *
      Math.min(
        share((value) => value <= 0),
        share((value) => value >= 0),
      ),
  );
  let result: ChangeVerdict['result'] = 'inconclusive';
  if (low > 0) result = 'better';
  else if (high < 0) result = 'worse';
  return {
    result,
    observed: mean(differences),
    low,
    high,
    p,
    queries: queries.length,
    replicates,
    seed,
  };
}
