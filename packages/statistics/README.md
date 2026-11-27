# @zukhruf/statistics

The percentile bootstrap, the quantile methods of NumPy, the Holm correction of statsmodels, and `numpy.sum`, `numpy.mean`, `numpy.nanmean` and `numpy.std` in JavaScript, to the last bit. Use it when a TypeScript eval must give the same interval as a Python program, such as the summary of a benchmark or the comparison of two models.

The package is public on npm. Until 2026-11-07 it was private and reached through a workspace path (ADR 0001); it became public with `@zukhruf/evals`, which depends on it (backlog #3888).

## Use it

```ts
import { Random } from 'python-random';

import {
  IidBootstrap,
  Linear,
  PercentileInterval,
  mean,
  nanmean,
  sum,
} from '@zukhruf/statistics';

const random = new Random(42);
const bootstrap = new IidBootstrap({
  nResamples: 1000,
  randomIndex: (n) => random.randrange(n),
});
const interval = bootstrap.interval(
  scores,
  (resample) =>
    resample.reduce((sum, score) => sum + score, 0) / resample.length,
  new PercentileInterval({ low: 0.025, high: 0.975, method: new Linear() }),
);
interval.low; // the 2.5% quantile of the 1000 means, as numpy.percentile
interval.isAbove(0); // true when the whole interval lies above 0

new Linear().of([1, 2, 3, 4], 0.5); // 2.5, as numpy.quantile(a, 0.5)
sum([0.1, 0.2, 0.3]); // 0.6000000000000001, as numpy.sum(a)
mean([1, 2, 3, 4]); // 2.5, as numpy.mean(a)
nanmean([1, NaN, 3]); // 2, as numpy.nanmean(a)
```

| Export                     | NumPy, SciPy or arch                                                               | What it does                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sum`                      | `numpy.sum` of a 1-D float64 array                                                 | The pairwise sum of NumPy: blocks of up to 128 values in 8 accumulators, and two halves for more values. It starts from 0, so values of −0 give 0. No values give 0.                                                                                                                                                                                                                   |
| `mean`                     | `numpy.mean` of a 1-D float64 array                                                | `sum` divided by the number of values. No values give NaN.                                                                                                                                                                                                                                                                                                                             |
| `nanmean`                  | `numpy.nanmean` of a 1-D float64 array                                             | Each NaN becomes 0, `sum` adds all the values, and the sum is divided by the number of values that are not NaN. A `mean` of only the values that are not NaN can give other last bits. No values, or only NaN values, give NaN.                                                                                                                                                        |
| `std`                      | `numpy.std` of a 1-D float64 array, with its `ddof`                                | The square root of the `sum` of the squared deviations from the `mean`, divided by n − `ddof`. `ddof` is 0 by default (the population standard deviation), and `ddof: 1` gives the sample standard deviation. No values give NaN. A `ddof` of n or more divides by 0: NaN or Infinity, as NumPy gives them.                                                                            |
| `QuantileMethod`           | the `method` of `numpy.quantile`                                                   | A rule that gives the value at the quantile `q` of sorted values: `of(sorted, q)`. `q` is from 0 to 1. A `q` out of that range, or no values, throws a `RangeError`.                                                                                                                                                                                                                   |
| `Lower`                    | `method='lower'`                                                                   | The value at the index `floor((n − 1)q)`.                                                                                                                                                                                                                                                                                                                                              |
| `Higher`                   | `method='higher'`                                                                  | The value at the index `ceil((n − 1)q)`.                                                                                                                                                                                                                                                                                                                                               |
| `Linear`                   | `method='linear'`, the default of NumPy                                            | The line between the two values around the index `(n − 1)q`, computed as NumPy's `_lerp` computes it, so the bits are NumPy's. d3-array's `quantileSorted` gives other bits for 1 value of 10.                                                                                                                                                                                         |
| `InvertedCdf`              | `method='inverted_cdf'`                                                            | The nearest rank: the value at the index `ceil(nq) − 1`, and the first value when `q` is 0.                                                                                                                                                                                                                                                                                            |
| `ConfidenceInterval`       | the `ConfidenceInterval` of `scipy.stats.bootstrap`                                | `low` and `high`. `isAbove(value)` is true when `low > value`, and `isBelow(value)` is true when `high < value`: the whole interval lies on one side of the value.                                                                                                                                                                                                                     |
| `DifferenceInterval`       | the `ConfidenceInterval` of `scipy.stats.bootstrap`, with the observed statistic   | A `ConfidenceInterval` of (change − baseline) with `observed`: the difference that the data gives. `new DifferenceInterval(low, high, observed)` makes one. It is data only: it has no verdict. mteb's `ChangeVerdict`, the `Interval` of relevance-filtering and the `Interval` of event-detection hold the same three values. `@zukhruf/evals` gives it in each verdict of two runs. |
| `ConfidenceIntervalMethod` | the `method` of `scipy.stats.bootstrap`                                            | A rule that gives the confidence interval of a bootstrap distribution: `of(distribution)`, and states its `level`, the share of the distribution that the interval covers, such as 0.95 (`confidence_level` of SciPy). `PercentileInterval` is one. A caller with a rule of its own writes another.                                                                                    |
| `PercentileInterval`       | `method='percentile'` of `scipy.stats.bootstrap`                                   | The `low` and the `high` quantile of a bootstrap distribution, both read with one quantile method, as `numpy.percentile` reads them. It sorts a copy, so the distribution does not change. Its `level` is `high` minus `low`.                                                                                                                                                          |
| `IidBootstrap`             | `arch.bootstrap.IIDBootstrap`; `n_resamples` and `bootstrap_distribution` of SciPy | Draws `nResamples` resamples of the data, with replacement. `distribution(data, statistic)` gives the statistic of each resample. `interval(data, statistic, method)` gives the interval that a `ConfidenceIntervalMethod` reads from that distribution. Data with no items throws a `RangeError`.                                                                                     |

The random generator is an input. `randomIndex(n)` gives an index from 0 to n − 1. Each item of a resample takes one call, in order, resample by resample, as a Python loop over the same generator does. So `(n) => random.randrange(n)` of python-random draws as CPython's `random.Random`, and a port of NumPy's `default_rng` draws as `integers(0, n, n)` when it draws one index for each call. An index out of range throws a `RangeError`.

These parts stay with each caller, because each caller has its own rule:

- the random generators: python-random is on npm, and the NumPy generators are in `@zukhruf/random`. Each caller gives `randomIndex`;
- a stratified bootstrap (relevance-filtering) and a block bootstrap (`@zukhruf/event-detection`): they draw their own resamples and give their distribution to `PercentileInterval`;
- an interval with a rule of its own at each end, such as the `lower` method at the low end and the `higher` method at the high end of the Structured Output Benchmark: its caller writes it as a `ConfidenceIntervalMethod`;
- a p-value and a verdict, such as "better" when the interval of a difference lies above 0: each caller builds its rule from `isAbove` and `isBelow`.

## Give the standard deviation that NumPy gives

`std(values)` gives the value of `numpy.std(a)`, to the last bit. It adds the values and the squared deviations in the pairwise order of NumPy, so a large mean with small deviations gives the same bits as NumPy. Give `ddof` as NumPy names it:

```ts
import { std } from '@zukhruf/statistics';

std([1, 2, 3, 4]); // 1.118033988749895, as numpy.std(a)
std([1, 2, 3, 4], { ddof: 1 }); // 1.2909944487358056, as numpy.std(a, ddof=1)
```

## Adjust the p-values of many tests

When one run tests many hypotheses, such as each score of a comparison of two models, some test passes a level by chance alone. A `MultipleTestCorrection` adjusts the p-values of the family, so that each test can read its adjusted p-value against the level (Strategy, ADR 0003). `Holm` gives the values of `multipletests(p, method="holm")[1]` of statsmodels 0.15.0, to the last bit, in the order of the p-values that you give it:

```ts
import { Holm } from '@zukhruf/statistics';

new Holm().adjust([0.04, 0.001, 0.03, 0.2, 0.01]); // [0.09, 0.005, 0.09, 0.2, 0.04]
```

Holm's step-down correction multiplies the k-th smallest of n p-values by n − k + 1, keeps a running maximum in that order, and caps each value at 1 (Holm 1979). A test is significant at a level when its adjusted p-value is at most that level. R names the same rule `p.adjust(p, method = "holm")`.

## Errors

Each error is a `RangeError`. Its message says which input is out of range.

| Error        | When                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RangeError` | `QuantileMethod.of` gets a `q` that is not from 0 to 1, or NaN: `A quantile is from 0 to 1, not 1.5` (`src/quantile/quantile-method.ts`).                 |
| `RangeError` | `QuantileMethod.of` gets no values: `A quantile needs at least one value`. `PercentileInterval.of` of an empty distribution throws it too.                |
| `RangeError` | `IidBootstrap.distribution` or `IidBootstrap.interval` gets data with no items: `A bootstrap needs at least one item` (`src/bootstrap/iid-bootstrap.ts`). |
| `RangeError` | `randomIndex(n)` gives an index out of 0 to n − 1: `A random index is from 0 to 9, not 10`.                                                               |

## API

```ts
// numpy.sum, numpy.mean, numpy.nanmean and numpy.std of a 1-D float64 array.
function sum(values: ArrayLike<number>): number;
function mean(values: ArrayLike<number>): number;
function nanmean(values: ArrayLike<number>): number;
function std(
  values: ArrayLike<number>,
  options?: { readonly ddof?: number },
): number;

// A method of numpy.quantile. A subclass gives only where its rule reads the values.
abstract class QuantileMethod {
  of(sorted: readonly number[], q: number): number;
  protected abstract valueAt(sorted: readonly number[], q: number): number;
  protected static value(sorted: readonly number[], index: number): number;
}
class Lower extends QuantileMethod {}
class Higher extends QuantileMethod {}
class Linear extends QuantileMethod {}
class InvertedCdf extends QuantileMethod {}

class ConfidenceInterval {
  constructor(low: number, high: number);
  readonly low: number;
  readonly high: number;
  isAbove(value: number): boolean;
  isBelow(value: number): boolean;
}

class DifferenceInterval extends ConfidenceInterval {
  constructor(low: number, high: number, observed: number);
  readonly observed: number;
}

// The method of scipy.stats.bootstrap. Exported as a type only.
interface ConfidenceIntervalMethod {
  readonly level: number;
  of(distribution: readonly number[]): ConfidenceInterval;
}

class PercentileInterval implements ConfidenceIntervalMethod {
  constructor(options: {
    readonly low: number;
    readonly high: number;
    readonly method: QuantileMethod;
  });
  get level(): number;
  of(distribution: readonly number[]): ConfidenceInterval;
}

// The method of statsmodels' multipletests and R's p.adjust. Exported as a type only.
interface MultipleTestCorrection {
  adjust(pValues: readonly number[]): number[];
}

class Holm implements MultipleTestCorrection {
  adjust(pValues: readonly number[]): number[];
}

class IidBootstrap {
  constructor(options: {
    readonly nResamples: number;
    readonly randomIndex: (n: number) => number;
  });
  distribution<T>(
    data: readonly T[],
    statistic: (resample: readonly T[]) => number,
  ): number[];
  interval<T>(
    data: readonly T[],
    statistic: (resample: readonly T[]) => number,
    method: ConfidenceIntervalMethod,
  ): ConfidenceInterval;
}
```

## Documentation

**Recipes**

- [Give the interval that a Python program gives](./docs/recipes/give-the-interval-that-a-python-program-gives.md)
- [Read an interval from resamples that you draw yourself](./docs/recipes/read-an-interval-from-resamples-you-draw.md)

**Decisions**

- [ADR 0001: one home for the percentile bootstrap that six places copied, reached through a workspace path](docs/adr/0001-one-home-for-the-percentile-bootstrap-that-six-places-copied.md)
- [ADR 0002: one home for the pairwise sum of NumPy that four places copied](docs/adr/0002-one-home-for-the-pairwise-sum-of-numpy-that-four-places-copied.md)
