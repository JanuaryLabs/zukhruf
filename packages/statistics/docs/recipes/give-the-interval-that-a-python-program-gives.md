# Recipe: Give the interval that a Python program gives

**Use case.** A Python program gives the confidence interval of a mean score with a percentile bootstrap, and a TypeScript eval must give the same interval for the same scores. Both must draw the same resamples and read the same quantiles of the bootstrap distribution. When the TypeScript side draws with `Math.random`, or reads the quantiles with another quantile method, the two intervals differ, and a reader cannot tell a bug from a change in the scores. `IidBootstrap` draws one random index for each item, in order, resample by resample, as a Python loop over the same generator does. `PercentileInterval` with `Linear` reads both ends as `numpy.percentile` reads them.

**What you need.** The seed of the Python program and its generator: `random.Random` of CPython (python-random on npm), or `numpy.random.default_rng` (`@zukhruf/random`). The statistic of the Python program, such as `numpy.mean`, and its two quantiles.

## The steps

1. Make the generator of the Python program with the same seed: `new Random(seed)` of python-random for `random.Random(seed)`.
2. Give `IidBootstrap` a `randomIndex` that draws one index from 0 to n − 1 as the Python program draws it: `(n) => random.randrange(n)` for `rng.randrange(n)`.
3. Give the statistic of the Python program. `mean` of this package is `numpy.mean` to the last bit.
4. Read the interval with `new PercentileInterval({ low, high, method: new Linear() })`, as `numpy.percentile(distribution, [low * 100, high * 100])` reads it.

## The program

The Python program draws 1000 resamples of 12 scores with `random.Random(42)`, takes the mean of each, and reads the 2.5% and the 97.5% quantile:

```py title="summary.py"
# /// script
# requires-python = "==3.12.9"
# dependencies = ["numpy==2.5.4"]
# ///
import random

import numpy as np

scores = [0.82, 0.41, 0.97, 0.66, 0.73, 0.15, 0.88, 0.59, 0.94, 0.37, 0.71, 0.62]

rng = random.Random(42)
means = []
for _ in range(1000):
    resample = [scores[rng.randrange(len(scores))] for _ in range(len(scores))]
    means.append(np.mean(resample))
low, high = np.percentile(means, [2.5, 97.5])
print(f"mean {float(np.mean(scores))!r}")
print(f"low  {float(low)!r}")
print(f"high {float(high)!r}")
```

Output of `uv run summary.py`, with CPython 3.12.9 and NumPy 2.5.4:

```
mean 0.6541666666666667
low  0.5233125
high 0.7783333333333333
```

The TypeScript program gives the same interval for the same scores and the same seed:

```ts title="summary.ts"
import { Random } from 'python-random';

import {
  IidBootstrap,
  Linear,
  PercentileInterval,
  mean,
} from '@zukhruf/statistics';

const scores = [
  0.82, 0.41, 0.97, 0.66, 0.73, 0.15, 0.88, 0.59, 0.94, 0.37, 0.71, 0.62,
];

// random.Random(42) of CPython, and one randrange(n) for each item.
const random = new Random(42);
const bootstrap = new IidBootstrap({
  nResamples: 1000,
  randomIndex: (n) => random.randrange(n),
});

// numpy.percentile(means, [2.5, 97.5]) reads both ends with method='linear'.
const interval = bootstrap.interval(
  scores,
  mean,
  new PercentileInterval({ low: 0.025, high: 0.975, method: new Linear() }),
);

console.log(`mean ${mean(scores)}`);
console.log(`low  ${interval.low}`);
console.log(`high ${interval.high}`);
```

Output of `node --conditions=@zukhruf/source summary.ts`:

```
mean 0.6541666666666667
low  0.5233125
high 0.7783333333333333
```

## What the output shows

The two programs print the same three numbers, to the last digit. The two programs share three parts: the random indices (12 for each of the 1000 resamples), the statistic of each resample, and the quantile method of the two ends. A change to one of these parts can move an end of the interval.

## Draw as NumPy's default_rng

A Python program that draws with `numpy.random.default_rng(seed)` takes the indices of a resample with `rng.integers(0, n, n)`. That call draws its n indices one at a time, so `integers(0, n, 1)` for each item gives the same indices. The relevance-filtering eval draws its topic bootstrap in this way ([eval/bootstrap.ts](../../../information-filtering/relevance-filtering/eval/bootstrap.ts)).

```py title="summary_numpy.py"
# /// script
# requires-python = "==3.12.9"
# dependencies = ["numpy==2.5.4"]
# ///
import numpy as np

scores = np.array([0.82, 0.41, 0.97, 0.66, 0.73, 0.15, 0.88, 0.59, 0.94, 0.37, 0.71, 0.62])

rng = np.random.default_rng(42)
means = [np.mean(scores[rng.integers(0, len(scores), len(scores))]) for _ in range(1000)]
low, high = np.percentile(means, [2.5, 97.5])
print(f"low  {float(low)!r}")
print(f"high {float(high)!r}")
```

Output of `uv run summary_numpy.py`, with CPython 3.12.9 and NumPy 2.5.4:

```
low  0.5158333333333334
high 0.7775208333333333
```

```ts title="summary-numpy.ts"
import { defaultRng } from '@zukhruf/random';
import {
  IidBootstrap,
  Linear,
  PercentileInterval,
  mean,
} from '@zukhruf/statistics';

const scores = [
  0.82, 0.41, 0.97, 0.66, 0.73, 0.15, 0.88, 0.59, 0.94, 0.37, 0.71, 0.62,
];

// numpy.random.default_rng(42). integers(0, n, n) draws its n indices one at
// a time, so integers(0, n, 1) for each item gives the same indices.
const generator = defaultRng(42);
const bootstrap = new IidBootstrap({
  nResamples: 1000,
  randomIndex: (n) => generator.integers(0, n, 1)[0] ?? Number.NaN,
});

const interval = bootstrap.interval(
  scores,
  mean,
  new PercentileInterval({ low: 0.025, high: 0.975, method: new Linear() }),
);

console.log(`low  ${interval.low}`);
console.log(`high ${interval.high}`);
```

Output of `node --conditions=@zukhruf/source summary-numpy.ts`:

```
low  0.5158333333333334
high 0.7775208333333333
```

## Things to know

- **Draw with the call that the Python program uses.** `random.choice(seq)` draws as `randrange(len(seq))`, but `random.choices(seq, k=n)` draws `floor(random() * n)` and gives other indices for the same seed. With `random.Random(42)` and 12 items, `randrange` gives `10, 1, 0, 11` first, and `choices` gives `7, 0, 3, 2` (CPython 3.12.9, [Lib/random.py](https://github.com/python/cpython/blob/v3.12.9/Lib/random.py)).
- **Keep the order of the draws.** One generator that serves more than one interval gives each interval the draws that follow the last one. Compute the intervals in the order of the Python program. The Structured Output Benchmark summary of offers-evals uses one `Random` for each summary, and draws for each score in the order of `summarize_rows`.
- **`mean` is `numpy.mean`; a loop with `+` is not.** `numpy.mean` adds with the pairwise sum, so a mean with a plain loop can give other last bits ([ADR 0002](../adr/0002-one-home-for-the-pairwise-sum-of-numpy-that-four-places-copied.md)).
- **`@zukhruf/random` is private.** Its `package.json` has `"private": true`, so only programs in this workspace import it. python-random is on npm.
- **An index out of range throws a `RangeError`.** `IidBootstrap` refuses an index that is not a whole number from 0 to n − 1, and data with no items ([iid-bootstrap.test.ts](../../src/bootstrap/iid-bootstrap.test.ts)).
- **A bootstrap with strata or blocks draws its own resamples.** Give its bootstrap distribution to `PercentileInterval` ([Read an interval from resamples you draw](./read-an-interval-from-resamples-you-draw.md)).
