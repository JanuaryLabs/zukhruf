# @zukhruf/statistics

The percentile bootstrap and the quantile methods of NumPy in JavaScript, to the last bit. Use it when a TypeScript eval must give the same interval as a Python program, such as the summary of a benchmark or the comparison of two models.

The package is private: a workspace reaches it through its path (ADR 0001).

## Use it

```ts
import { Random } from 'python-random';

import { IidBootstrap, Linear, PercentileInterval } from '@zukhruf/statistics';

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
```

| Export                     | NumPy, SciPy or arch                                                               | What it does                                                                                                                                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QuantileMethod`           | the `method` of `numpy.quantile`                                                   | A rule that gives the value at the quantile `q` of sorted values: `of(sorted, q)`. `q` is from 0 to 1. A `q` out of that range, or no values, throws a `RangeError`.                                                                                                                               |
| `Lower`                    | `method='lower'`                                                                   | The value at the index `floor((n − 1)q)`.                                                                                                                                                                                                                                                          |
| `Higher`                   | `method='higher'`                                                                  | The value at the index `ceil((n − 1)q)`.                                                                                                                                                                                                                                                           |
| `Linear`                   | `method='linear'`, the default of NumPy                                            | The line between the two values around the index `(n − 1)q`, computed as NumPy's `_lerp` computes it, so the bits are NumPy's. d3-array's `quantileSorted` gives other bits for 1 value of 10.                                                                                                     |
| `InvertedCdf`              | `method='inverted_cdf'`                                                            | The nearest rank: the value at the index `ceil(nq) − 1`, and the first value when `q` is 0.                                                                                                                                                                                                        |
| `ConfidenceInterval`       | the `ConfidenceInterval` of `scipy.stats.bootstrap`                                | `low` and `high`. `isAbove(value)` is true when `low > value`, and `isBelow(value)` is true when `high < value`: the whole interval lies on one side of the value.                                                                                                                                 |
| `ConfidenceIntervalMethod` | the `method` of `scipy.stats.bootstrap`                                            | A rule that gives the confidence interval of a bootstrap distribution: `of(distribution)`. `PercentileInterval` is one. A caller with a rule of its own writes another.                                                                                                                            |
| `PercentileInterval`       | `method='percentile'` of `scipy.stats.bootstrap`                                   | The `low` and the `high` quantile of a bootstrap distribution, both read with one quantile method, as `numpy.percentile` reads them. It sorts a copy, so the distribution does not change.                                                                                                         |
| `IidBootstrap`             | `arch.bootstrap.IIDBootstrap`; `n_resamples` and `bootstrap_distribution` of SciPy | Draws `nResamples` resamples of the data, with replacement. `distribution(data, statistic)` gives the statistic of each resample. `interval(data, statistic, method)` gives the interval that a `ConfidenceIntervalMethod` reads from that distribution. Data with no items throws a `RangeError`. |

The random generator is an input. `randomIndex(n)` gives an index from 0 to n − 1. Each item of a resample takes one call, in order, resample by resample, as a Python loop over the same generator does. So `(n) => random.randrange(n)` of python-random draws as CPython's `random.Random`, and a port of NumPy's `default_rng` draws as `integers(0, n, n)` when it draws one index for each call. An index out of range throws a `RangeError`.

These parts stay with each caller, because each caller has its own rule:

- the random generators: python-random is on npm, and the NumPy generator is a port in `@zukhruf/mteb` and in the eval of `@zukhruf/relevance-filtering`;
- a stratified bootstrap (relevance-filtering) and a block bootstrap (`@zukhruf/event-detection`): they draw their own resamples and give their distribution to `PercentileInterval`;
- an interval with a rule of its own at each end, such as the `lower` method at the low end and the `higher` method at the high end of the Structured Output Benchmark: its caller writes it as a `ConfidenceIntervalMethod`;
- a p-value and a verdict, such as "better" when the interval of a difference lies above 0: each caller builds its rule from `isAbove` and `isBelow`.

## Documentation

- [ADR 0001: one home for the percentile bootstrap that six places copied, reached through a workspace path](docs/adr/0001-one-home-for-the-percentile-bootstrap-that-six-places-copied.md)
