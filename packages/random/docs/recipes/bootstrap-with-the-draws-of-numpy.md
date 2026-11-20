# Recipe: Give a bootstrap the draws of a NumPy program

**Use case.** A Python program seeds `numpy.random.default_rng` and draws the resamples of a bootstrap with `integers(0, n, n)`. You port that program to TypeScript, and the port must give the same interval, to the last bit. `IidBootstrap` of `@zukhruf/statistics` does not depend on this package: it takes a `randomIndex` function, and calls it once for each item of each resample ([statistics README](../../../statistics/README.md)). So the port must give `randomIndex` the draws of NumPy. Three places write the same adapter for this: the paired bootstrap of mteb (`packages/mteb/src/significance/paired-bootstrap.ts:70`), the topic bootstrap of the relevance-filtering eval (`packages/information-filtering/relevance-filtering/eval/bootstrap.ts:42`), and the golden test of `PairedBootstrap` in evals (`packages/evals/src/scoring/paired-bootstrap.golden.test.ts:76`).

**What you need.** The seed of the Python program, `defaultRng` of `@zukhruf/random`, and `IidBootstrap`, `PercentileInterval`, `Linear` and `mean` of `@zukhruf/statistics`.

## The steps

1. Make the generator with `defaultRng(seed)`, with the seed of the Python program.
2. Give `IidBootstrap` the adapter `randomIndex: (n) => generator.integers(0, n, 1)[0] ?? Number.NaN`.
3. Make no other draw on that generator between the resamples.

## The program

The program bootstraps the mean of 10 differences, with 10,000 resamples and the seed 42. It records each random index. It then compares the indices with one draw of `integers(0, 10, 100000)` from a new generator with the same seed, and prints the interval.

```ts title="bootstrap.ts"
import { defaultRng } from '@zukhruf/random';
import {
  IidBootstrap,
  Linear,
  PercentileInterval,
  mean,
} from '@zukhruf/statistics';

// The difference of a score on 10 queries: change minus baseline.
const differences = [0.12, -0.03, 0.08, 0.15, 0, 0.05, -0.02, 0.11, 0.07, 0.04];

const generator = defaultRng(42);
const drawn: number[] = [];
const bootstrap = new IidBootstrap({
  nResamples: 10_000,
  // One random index for each call: NumPy's integers(0, n, n) draws its n
  // indices one at a time, so this gives the same stream.
  randomIndex: (n) => {
    const index = generator.integers(0, n, 1)[0] ?? Number.NaN;
    drawn.push(index);
    return index;
  },
});
const interval = bootstrap.interval(
  differences,
  mean,
  new PercentileInterval({ low: 0.025, high: 0.975, method: new Linear() }),
);

console.log(`first resample: [${drawn.slice(0, 10).join(', ')}]`);
const inOneDraw = defaultRng(42).integers(0, 10, drawn.length);
console.log(
  'same as integers(0, 10, 100000):',
  inOneDraw.every((index, at) => index === drawn[at]),
);
console.log('low:', interval.low);
console.log('high:', interval.high);
console.log('above 0:', interval.isAbove(0));
```

Output (the seed 42 makes the same output on each run):

```
first resample: [0, 7, 6, 4, 4, 8, 0, 6, 2, 0]
same as integers(0, 10, 100000): true
low: 0.021
high: 0.09299999999999999
above 0: true
```

## The same bootstrap in NumPy

This Python program draws all the indices in one call, as a NumPy program often does. Run it with NumPy 2.5.4:

```sh
uv run --no-project --with numpy==2.5.4 python -I bootstrap.py
```

```py title="bootstrap.py"
import numpy as np

differences = np.array([0.12, -0.03, 0.08, 0.15, 0, 0.05, -0.02, 0.11, 0.07, 0.04])

generator = np.random.default_rng(42)
indices = generator.integers(0, 10, (10_000, 10))
means = differences[indices].mean(axis=1)
low, high = np.percentile(means, [2.5, 97.5])

print("first resample:", indices[0].tolist())
print("low:", float(low))
print("high:", float(high))
```

Output:

```
first resample: [0, 7, 6, 4, 4, 8, 0, 6, 2, 0]
low: 0.021
high: 0.09299999999999999
```

## What the output shows

- **The draws are the same.** The first resample of the TypeScript program is the first row of the NumPy program. All 100,000 random indices are the same as one draw of `integers(0, 10, 100000)`.
- **The interval is the same, to the last bit.** Both programs give a high end of `0.09299999999999999`, not `0.093`. `mean` of `@zukhruf/statistics` adds in the order of `numpy.mean`, and `Linear` reads the quantile as `numpy.percentile` does ([statistics README](../../../statistics/README.md)).
- **The adapter draws one index for each call.** `IidBootstrap` calls `randomIndex` once for each item, in order, resample by resample (`packages/statistics/src/bootstrap/iid-bootstrap.ts`). `Generator.integers` draws the items of one call one at a time, by Lemire's method ([README](../../README.md#the-parts)). So 10 calls of size 1 take the same numbers of the stream as 1 call of size 10.

## Things to know

- **`integers(0, n, 1)` always gives one index.** The `?? Number.NaN` is there only for the type of an array access. When an index is not from 0 to n − 1, `IidBootstrap` throws a `RangeError` that names it (`packages/statistics/src/bootstrap/iid-bootstrap.ts`).
- **The order of the draws is the order of the results.** Another draw on the same generator, such as a shuffle between two bootstraps, takes numbers of the stream. Make it at the same place as the Python program makes it ([CONTEXT.md](../../CONTEXT.md), "Draw").
- **A paired bootstrap takes the same adapter.** `PairedBootstrap` of `@zukhruf/evals` takes `randomIndex` too, and its golden test proves the adapter against NumPy (`packages/evals/src/scoring/paired-bootstrap.golden.test.ts`). The recipe [Compare a change with a baseline run](../../../evals/docs/recipes/compare-a-change-with-a-baseline-run.md) uses it.
