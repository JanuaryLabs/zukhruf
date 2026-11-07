# @zukhruf/random

> **Status: in use.** mteb and the eval of relevance-filtering draw from this package, and its tests prove it against NumPy 2.5.4. The decisions are in [ADR 0001](docs/adr/0001-one-package-for-the-generators-of-numpy-random.md).

The generators of `numpy.random` in JavaScript, to the last bit. Use it when a TypeScript port must draw the same numbers as a Python program that seeds NumPy, such as the bootstrap of a benchmark or the split of a dataset.

The package is private: a workspace reaches it through its path (ADR 0001). It is in the publish set of backlog #3865. The words are defined in [CONTEXT.md](CONTEXT.md).

## Use it

```ts
import { RandomState, defaultRng } from '@zukhruf/random';

const generator = defaultRng(42);
generator.integers(0, 10, 5); // [0, 7, 6, 4, 4]
generator.permutation(5); // [0, 3, 4, 1, 2]
generator.choice([10, 20, 30, 40, 50], 2, { replace: false }); // [10, 30]

defaultRng(2n ** 70n + 3n).integers(0, 1000, 3); // [141, 420, 270]

const legacy = new RandomState(42);
legacy.randint(0, 10, 5); // [6, 3, 7, 4, 6]
legacy.randomSample(2); // [0.44583275285359114, 0.09997491581800289]
legacy.choice(3, 4, { p: [0.5, 0.25, 0.25] }); // [0, 0, 0, 1]
```

Each value in the comments is what NumPy 2.5.4 gives for the same calls in the same order (`numpy.random.default_rng(42)`, `numpy.random.RandomState(42)`).

## The parts

`RandomState` moves here from mteb with its name. `NumpyGenerator` becomes `Generator` and `defaultRng`. The other exports are new. Each class keeps the name of its NumPy class, so a reader finds the source of each rule in NumPy.

| Export         | NumPy                                                     | What it does                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SeedSequence` | `numpy.random.SeedSequence`                               | `new SeedSequence(seed)` mixes the seed into a pool of 4 words of 32 bits. `generateState(nWords)` gives `nWords` words of 32 bits from the pool, as `generate_state(n_words, dtype=np.uint32)` gives them.                                                                                                                                                                                                                                |
| `BitGenerator` | `numpy.random.BitGenerator` (the `bitgen_t` of C)         | An interface: `nextUint32()` gives the next 32 bits of the stream. `Generator` takes any bit generator.                                                                                                                                                                                                                                                                                                                                    |
| `PCG64`        | `numpy.random.PCG64`                                      | PCG64 with the XSL-RR output: 128 bits of state, 64 bits for each step. `new PCG64(seed)` or `new PCG64(seedSequence)`. `nextUint32()` gives the low half of a 64-bit output and keeps the high half for the next call, as NumPy keeps it in the bit generator. So two draws that share one generator share that half.                                                                                                                     |
| `MT19937`      | `numpy.random.MT19937`, `_legacy_seeding`                 | The Mersenne Twister. `MT19937.legacy(seed)` seeds it with `init_genrand`, as `RandomState(seed)` seeds it. The seed is from 0 to 2^32 − 1. `nextUint32()` gives the next word, and `nextDouble()` gives a float of 53 bits in [0, 1) from two words.                                                                                                                                                                                      |
| `Generator`    | `numpy.random.Generator`                                  | `new Generator(bitGenerator)`. `integers(low, high, size)`: `size` integers in [low, high), by Lemire's method. `shuffle(values)`: shuffles in place, by masked rejection. `permutation(n)` or `permutation(values)`: a shuffled `0 … n − 1`, or a shuffled copy. `choice(a, size, { replace: false })`: `size` distinct items of the array `a`, by Floyd's algorithm, in a shuffled order.                                                |
| `defaultRng`   | `numpy.random.default_rng`                                | `defaultRng(seed)` is `new Generator(new PCG64(new SeedSequence(seed)))`.                                                                                                                                                                                                                                                                                                                                                                  |
| `RandomState`  | `numpy.random.RandomState`, the legacy generator of NumPy | `new RandomState(seed)` or `new RandomState(mt19937)`. `randomSample(size)` and `uniform(size)`: floats in [0, 1). `randint(low, high, size)`: integers in [low, high), by masked rejection. `choice(a, size)`, `choice(a, size, { p })` and `choice(a, size, { replace: false })`, where `a` is an array, or `n` for `0 … n − 1`. `permutation(n)` and `shuffle(values)`. scikit-learn's `check_random_state(seed)` gives this generator. |

`random_interval` (masked rejection) and `buffered_bounded_lemire_uint32` (Lemire's method) of NumPy's `distributions.c` are functions of the package over a `BitGenerator`. The package does not export them. `Generator` and `RandomState` both call the same `random_interval`, as NumPy calls one function with PCG64 or with MT19937.

## Seeds

A seed is a `number` or a `bigint`, from 0 up. A `bigint` gives the stream of a seed above 2^53, which a `number` cannot hold. NumPy takes an int of any size.

- A negative seed throws a `RangeError`, as NumPy raises a `ValueError` ("expected non-negative integer").
- A `number` that is not an integer, such as `1.5`, throws a `TypeError`, as NumPy raises a `TypeError`.
- A seed of `RandomState` or of `MT19937.legacy` above 2^32 − 1 throws a `RangeError`, as NumPy raises a `ValueError` ("Seed must be between 0 and 2\*\*32 - 1").

Both copies of the port today give the stream of `default_rng(4294967295)` for the seed −1 (`BigInt(-1) & MASK32` in `pool`), where NumPy raises a `ValueError`. The package fixes this, and a test proves the fix.

## Limits

The package ports the calls that its users make, and no more. A call outside its proven paths throws a `RangeError`, so it never gives numbers that NumPy does not give:

- `Generator.integers` and `RandomState.randint` take a range `high − low` of at most 2^32. NumPy uses 64-bit draws above that range. A range of 0 or less throws, as NumPy raises `ValueError: low >= high`. `RandomState.randint` throws for both today. `NumpyGenerator.integers` does not: `integers(5, 5, 1)` gives `[5]`, and a range above 2^32 gives numbers that NumPy does not give. Both throw in the package.
- `Generator.choice` uses Floyd's algorithm only. A population above 10,000 with a size above a 50th of it throws, because NumPy shuffles the tail of a permutation there. A size above the population throws, as NumPy raises a `ValueError`.
- `Generator.choice` has no `p` and no `replace: true`: its options type is `{ replace: false }`. `RandomState.choice` takes `p` only with replacement: its options type does not let `p` and `replace: false` go together. TypeScript refuses these calls, so they do not throw.
- `RandomState.uniform` takes no `low` and no `high`: it gives the same floats as `randomSample`.

## What it does not do

| What                                                                                  | Trigger                                             |
| ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| other distributions, such as `normal`, `random` and `binomial`                        | a user draws from that distribution                 |
| other bit generators: `Philox`, `SFC64`, `PCG64DXSM`, `MT19937` from a `SeedSequence` | a user draws from that bit generator                |
| 64-bit draws: ranges above 2^32, `nextUint64`                                         | a user draws such a range                           |
| `Generator.choice` with `p`, with `replace: true`, or by the tail shuffle             | a user calls it                                     |
| a global generator, such as `numpy.random.seed` and `numpy.random.randint`            | none: a user always holds its generator (NEP 19)    |
| a `Generator` from a `SeedSequence` of many words, or `spawn`                         | a user seeds with a list of ints or spawns children |

## Proof

The package draws as NumPy 2.5.4 draws, bit for bit. `src/fixtures/generate.py` writes `src/fixtures/expected.json` with NumPy 2.5.4:

```sh
uv run --no-project --with numpy==2.5.4 python -I packages/random/src/fixtures/generate.py
```

`src/random.golden.test.ts` reads it:

- the words of `SeedSequence.generateState`, `PCG64` and `MT19937.legacy`;
- the draws of `RandomState`, from a seed and from an `MT19937`: the `numpy` cases of mteb's golden fixture, and choices from an array with `p` and without replacement;
- the draws of `Generator`, from `defaultRng` and over `MT19937.legacy`: the `generator_cases` of mteb's golden fixture, the integers of `default_rng(31957)` and of `default_rng(2^40 + 5)` that both copies tested, the `bigint` seed 2^70 + 3, and the ranges 1, 2^32 − 1 and 2^32;
- the refusals: each call for which NumPy raises throws here, a `ValueError` as a `RangeError` with NumPy's message, and a `TypeError` as a `TypeError`, with each integer seed as a `number` and as a `bigint`. `RandomState.choice` refuses the weights `p` that NumPy refuses: a length other than `a`'s, a NaN, a negative weight, or a sum that is not 1 within the square root of the epsilon of the float type of `p` (`float32` for a `Float32Array`).

`src/proven-paths.test.ts` proves that the calls outside the proven paths throw a `RangeError`, where NumPy gives numbers: a range of 2^32 + 1, and a choice of more than a 50th of a population above 10,000 (201 of 10,001).

## Who uses each part

| User                                      | Part                                                                   | Place                                                                                  |
| ----------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| mteb, the paired bootstrap test           | `Generator.integers`, through the `randomIndex` of statistics          | `packages/mteb/src/significance/paired-bootstrap.ts:62`, `:67`                         |
| mteb, multilabel classification           | `Generator.shuffle`                                                    | `packages/mteb/src/abstasks/multilabel-classification.ts:77`, `:218`                   |
| mteb, the stratified split of datasets    | `Generator.permutation`, `Generator.choice`                            | `packages/mteb/src/dependencies/datasets-train-test-split.ts:26`, `:74`, `:75`, `:100` |
| mteb, the regression golden test          | `Generator.integers`                                                   | `packages/mteb/src/dependencies/regression.golden.test.ts:83`                          |
| mteb, scikit-learn's MiniBatchKMeans      | `RandomState.randint`, `choice` with `p`, `choice` without replacement | `packages/mteb/src/dependencies/sklearn-kmeans.ts:64`, `:67`, `:70`, `:148`, `:238`    |
| mteb, classification                      | `RandomState.shuffle`                                                  | `packages/mteb/src/abstasks/classification.ts:316`                                     |
| mteb, the iterative stratification        | `RandomState.choice`                                                   | `packages/mteb/src/abstasks/stratification.ts:57`, `:142`, `:158`                      |
| relevance-filtering eval, topic bootstrap | `Generator.integers`, through the `randomIndex` of statistics          | `packages/information-filtering/relevance-filtering/eval/bootstrap.ts:38`, `:43`       |
| relevance-filtering eval, article weights | `Generator.integers`                                                   | `packages/information-filtering/relevance-filtering/eval/bootstrap.ts:59`, `:67`       |
| relevance-filtering eval, random labels   | `Generator.integers`                                                   | `packages/information-filtering/relevance-filtering/eval/daily.ts:280`                 |

`@zukhruf/statistics` does not depend on this package. Its `IidBootstrap` takes a `randomIndex` function, and each user gives `(n) => generator.integers(0, n, 1)[0]`.

## Documentation

- [ADR 0001: one package for the generators of numpy.random, reached through a workspace path](docs/adr/0001-one-package-for-the-generators-of-numpy-random.md)
