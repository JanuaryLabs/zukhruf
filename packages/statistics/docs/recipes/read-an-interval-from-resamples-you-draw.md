# Recipe: Read an interval from resamples that you draw yourself

**Use case.** `IidBootstrap` draws each item of a resample from all the data. Some evals must draw in another way. The relevance-filtering eval draws a stratified resample: each stratum draws as many items as it holds ([eval/bootstrap.ts](../../../information-filtering/relevance-filtering/eval/bootstrap.ts), `articleWeights`). The event-detection eval draws blocks of gold events, and scores two partitions on the same draw ([eval/bootstrap.ts](../../../information-filtering/event-detection/eval/bootstrap.ts), `pairedBootstrap`). These draws stay with each caller ([README](../../README.md)). The caller gives its bootstrap distribution to `PercentileInterval.of`, and the package reads the confidence interval from it.

**What you need.** A random generator, such as `Random` of python-random. A rule that draws each resample. A statistic for each resample. `PercentileInterval` with a quantile method.

## The steps

1. Draw each resample with your own rule, from your own random generator.
2. Compute the statistic of each resample. The list of these statistics is the bootstrap distribution.
3. Make a `PercentileInterval` with the `low` and the `high` quantile and a quantile method.
4. Give the bootstrap distribution to `of`. It gives a `ConfidenceInterval`.
5. To keep the observed difference with the interval, make a `DifferenceInterval(low, high, observed)`.

## The program

A baseline and a change answer the same 12 queries. The first 4 queries are hard. The program draws a stratified, paired bootstrap of the mean difference: each resample draws 4 hard queries and 8 easy queries, with replacement. For a comparison, it also reads the interval that `IidBootstrap` gives for the same data and the same seed.

```ts title="stratified.ts"
import { Random } from 'python-random';

import {
  DifferenceInterval,
  IidBootstrap,
  Linear,
  PercentileInterval,
  mean,
} from '@zukhruf/statistics';

// The number of correct answers, of 10, of a baseline and of a change on the
// same 12 queries. The first 4 queries are hard; the other 8 are easy.
const hard = Array.from({ length: 12 }, (_, index) => index < 4);
const baseline = [2, 1, 3, 2, 9, 8, 9, 10, 7, 9, 8, 10];
const change = [5, 3, 6, 2, 9, 9, 8, 10, 8, 9, 8, 9];
const differences = change.map((score, index) => score - baseline[index]!);

const percentile = new PercentileInterval({
  low: 0.025,
  high: 0.975,
  method: new Linear(),
});

// A stratified paired bootstrap: each resample draws as many hard queries as
// there are hard queries, and as many easy queries as there are easy queries,
// with replacement. Both systems are scored on the same draw.
function stratifiedDistribution(seed: number, nResamples: number): number[] {
  const random = new Random(seed);
  const strata = [true, false].map((inStratum) =>
    hard.flatMap((value, index) => (value === inStratum ? [index] : [])),
  );
  const distribution: number[] = [];
  for (let resample = 0; resample < nResamples; resample++) {
    const picked = strata.flatMap((members) =>
      members.map(() => members[random.randrange(members.length)]!),
    );
    distribution.push(mean(picked.map((index) => differences[index]!)));
  }
  return distribution;
}

const distribution = stratifiedDistribution(7, 2000);
const { low, high } = percentile.of(distribution);
const stratified = new DifferenceInterval(low, high, mean(differences));

const random = new Random(7);
const iid = new IidBootstrap({
  nResamples: 2000,
  randomIndex: (n) => random.randrange(n),
}).interval(differences, mean, percentile);

console.log(`observed difference: ${stratified.observed}`);
console.log(
  `stratified: [${stratified.low}, ${stratified.high}], above 0: ${stratified.isAbove(0)}`,
);
console.log(
  `iid:        [${iid.low}, ${iid.high}], above 0: ${iid.isAbove(0)}`,
);
```

Run it as `node --conditions=@zukhruf/source stratified.ts`. The seed is fixed, so each run gives this output.

Output:

```
observed difference: 0.6666666666666666
stratified: [0.16666666666666666, 1.1666666666666667], above 0: true
iid:        [0, 1.4166666666666667], above 0: false
```

## What the output shows

- The stratified interval lies above 0. Each resample holds 4 hard queries, and the change gains on 3 of the 4 hard queries of the data.
- The interval of `IidBootstrap` starts at 0, so `isAbove(0)` is false. An item of that resample comes from all 12 queries, so some resamples have few hard queries, and the mean difference of such a resample is 0 or less.
- Both intervals come from the same `PercentileInterval`. Only the draw changed, and the draw is the caller's rule.

## Things to know

- **`PercentileInterval.of` sorts a copy.** The bootstrap distribution that you give does not change ([percentile-interval.test.ts](../../src/interval/percentile-interval.test.ts)).
- **Choose the quantile method of the program that you compare with.** The relevance-filtering eval uses `Linear`, the default of `numpy.percentile`. The event-detection eval uses `InvertedCdf`, the nearest rank. See [Give the interval that a Python program gives](./give-the-interval-that-a-python-program-gives.md).
- **A rule of its own at each end is a `ConfidenceIntervalMethod`.** Write a class with `of(distribution)` that gives a `ConfidenceInterval` ([README](../../README.md)).
- **The verdict stays with you.** `DifferenceInterval` is data only. Read your verdict from `isAbove` and `isBelow` ([ADR 0001](../adr/0001-one-home-for-the-percentile-bootstrap-that-six-places-copied.md), #3819).
