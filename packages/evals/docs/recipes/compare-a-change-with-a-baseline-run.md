# Recipe: Compare a change with a baseline run

**Use case.** You run one harness two times on the same tests: once as the baseline run, and once with a change, such as another model or another prompt. The change run gives a higher recall. The question is: is the change better, or is the difference luck? Two means side by side do not answer it, because a small difference can be noise on a few tests ([ADR 0004](../adr/0004-two-runs-are-compared-by-a-paired-bootstrap-over-their-tests.md)). Without the package, you write a `Run` class and a bootstrap of the gains by hand. In offers-evals, an agent proposed a new `Run` class before it found that `@zukhruf/evals` already owns most of what it proposed (2026-11-12). Another agent sketched a bootstrap of the gains by hand to explain what `PairedBootstrap` does (2026-11-14).

**What you need.** The scorecards of the two runs, each with its test id and its weight. `Run` and `PairedBootstrap` of `@zukhruf/evals`, a generator of `@zukhruf/random`, and an interval method of `@zukhruf/statistics`.

## The steps

1. Make one `Run` for the baseline and one `Run` for the change.
2. Add the scorecard of each test to its run with `run.add(testId, scorecard, weight)`. Give the same test ids to the two runs.
3. Make a `PairedBootstrap` with the number of resamples, a seeded generator and a `PercentileInterval`.
4. Call `verdict(baseline, change, name, { higherIsBetter })` once for each name.

## The program

The program builds the scorecards in memory: 12 pages, each with its expected offers, and for each run the offers that the answer stated and the hits among them. A scorecard holds two ratios, `recall` and `precision`. The program then gives the verdict for each name.

```ts title="compare-runs.ts"
import { PairedBootstrap, Ratio, Run } from '@zukhruf/evals';
import { defaultRng } from '@zukhruf/random';
import { Linear, PercentileInterval } from '@zukhruf/statistics';

// One row for each test: its id, the expected offers, and for each run the
// offers that the answer stated and the hits among them.
const tests = [
  // id         expected  baseline [stated, hits]  change [stated, hits]
  ['page-01', 4, [3, 2], [4, 3]],
  ['page-02', 2, [2, 1], [2, 2]],
  ['page-03', 5, [4, 3], [5, 4]],
  ['page-04', 3, [3, 3], [3, 3]],
  ['page-05', 6, [4, 3], [6, 5]],
  ['page-06', 1, [1, 1], [2, 1]],
  ['page-07', 3, [2, 1], [3, 2]],
  ['page-08', 4, [4, 2], [4, 3]],
  ['page-09', 2, [1, 1], [2, 2]],
  ['page-10', 5, [5, 4], [5, 4]],
  ['page-11', 3, [3, 2], [4, 2]],
  ['page-12', 4, [2, 2], [4, 3]],
] as const;

// A scorecard of one answer: only its ratios matter to a run.
const scorecard = (
  expected: number,
  [stated, hits]: readonly [number, number],
) => ({
  ratios: new Map([
    ['recall', new Ratio(hits, expected)],
    ['precision', new Ratio(hits, stated)],
  ]),
});

const baseline = new Run();
const change = new Run();
for (const [id, expected, inBaseline, inChange] of tests) {
  baseline.add(id, scorecard(expected, inBaseline), 1);
  change.add(id, scorecard(expected, inChange), 1);
}

const generator = defaultRng(42);
const paired = new PairedBootstrap({
  nResamples: 10_000,
  randomIndex: (n) => generator.integers(0, n, 1)[0] ?? Number.NaN,
  interval: new PercentileInterval({
    low: 0.025,
    high: 0.975,
    method: new Linear(),
  }),
});

for (const name of ['recall', 'precision']) {
  const verdict = paired.verdict(baseline, change, name, {
    higherIsBetter: true,
  });
  const { observed, low, high } = verdict.difference;
  console.log(
    `${name}: ${verdict.result}, difference ${observed.toFixed(3)} in [${low.toFixed(3)}, ${high.toFixed(3)}], p ${verdict.p.toFixed(4)}`,
  );
  console.log(
    `  ${verdict.improvements} improvements, ${verdict.regressions} regressions, ${verdict.ties} ties of ${verdict.tests} tests`,
  );
}
```

Output (the seed 42 makes the same output on each run):

```
recall: better, difference 0.214 in [0.125, 0.300], p 0.0000
  8 improvements, 0 regressions, 4 ties of 12 tests
precision: inconclusive, difference 0.037 in [-0.064, 0.137], p 0.4732
  6 improvements, 3 regressions, 3 ties of 12 tests
```

## What the output shows

- **Recall is better.** The paired difference is 0.214: the change run has 34 hits of 42 expected offers, and the baseline run has 25 of 42. So 34/42 − 25/42 = 9/42. It is a ratio of sums over all the tests, as `Totals` gives it, not a mean of the values of the tests. The whole interval is above 0, so the verdict is better.
- **Precision is inconclusive.** The change run states more offers, so it has more hits and more misses. The paired difference is 0.037 (34/44 − 25/34), but the interval holds 0. Three tests are regressions. The program cannot say that the change is better for precision, and it cannot say that it is worse.
- **The counts are not the verdict.** Precision has 6 improvements and 3 regressions, and its verdict is still inconclusive. The verdict reads the interval of the resample differences.

## Why it works

Each resample draws 12 tests with replacement, and both runs read the same draw. A test that is hard for the baseline run is often hard for the change run too, so the pairing removes the difference between the tests from the noise (Koehn 2004, "Statistical significance tests for machine translation evaluation"). `PairedBootstrap` takes the ratio of sums of the name over the change run minus the same over the baseline run, on the same resampled tests. The interval method gives the 2.5% and the 97.5% quantiles of these differences. The verdict compares that interval with 0, in the direction that `higherIsBetter` gives ([README](../../README.md#compare-two-runs), `src/scoring/paired-bootstrap.ts`).

## Things to know

- **The two runs must have the same test ids.** A test id in one run only is a `RangeError` that names each such id. A test whose weight is not the same in the two runs is also a `RangeError` (`src/scoring/paired-bootstrap.test.ts`).
- **A second `add` of a test id is one more epoch of that test.** The run takes the mean of the epochs of a test, name by name, and the test stays the unit of the resample (ADR 0004, decision 2). An epoch with another weight is a `RangeError`.
- **A run reads only the ratios of a scorecard.** So a host that scores without a scorer of this package adds `{ ratios }` alone, as this program does (`src/scoring/paired-bootstrap.test.ts`). With a `ScorerSet`, add the scorecard that `scorer.score(stated, case)` gives.
- **The p-value has no correction.** This program tests two names, so a caller that reads the p-values corrects them, such as with Holm. A caller that tests one name does not apply a correction (ADR 0004, decision 7).
- **The generator is an input.** The order of the calls is the order of the draws: the precision verdict reads the generator after the recall verdict. A new seed gives other ends of the interval. With `defaultRng` of `@zukhruf/random`, the draws are the draws of NumPy's `default_rng` (`src/scoring/paired-bootstrap.golden.test.ts`).
- **Give `higherIsBetter: false` for a name where lower is better**, such as the Brier score. Then better and worse change places (ADR 0004, decision 5).
