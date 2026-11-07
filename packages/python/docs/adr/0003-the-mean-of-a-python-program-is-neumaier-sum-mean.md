# The mean that a Python program writes as sum(values) / len(values) is NeumaierSum.mean

Status: Accepted 2026-11-07 by Ezz (backlog #3927, Ezz: "approved").

A Python program often takes a mean as `sum(values) / len(values)`. For floats, `sum()` is the compensated sum of CPython 3.12, so the result is not the result of plain JavaScript addition: for ten values of `0.1`, Python gives `0.1`, and a JavaScript loop gives `0.09999999999999999`. Four places in the workspace and its consumers write this mean with `NeumaierSum`, and a test writes it a fifth time:

| Place                                                                           | Python that it ports                                                               | Count           | No value                                         |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | --------------- | ------------------------------------------------ |
| offers-evals `src/aggregation/mean.ts:5-9` `mean()`                             | `arithmetic_mean` of SOB's evaluate.py:734-737                                     | `values.length` | throws a `RangeError`                            |
| `MeanOf` (`@zukhruf/structured-eval` now, `@zukhruf/evals` in #3888)            | the mean of the scores of a category (`category_mean`, evaluate.py:752)            | the scorers     | `0 / 0`, so `NaN`                                |
| `@zukhruf/mteb` `src/evaluators/retrieval-metrics.ts:293`                       | `sum(mrr_scores[k]) / len(mrr_scores[k])` (MTEB 2.26.28, retrieval_metrics.py:633) | `values.length` | does not occur: a key has a value for each query |
| `@zukhruf/mteb` `src/report/report.ts:202`                                      | the mean of the score of each query, before the round to 5 digits                  | `values.size`   | `NaN`                                            |
| `@zukhruf/mteb` `src/significance/paired-bootstrap.golden.test.ts:130` (a test) | the same mean as report.ts                                                         | `values.size`   | `NaN`                                            |

This is the third place and more, so the rule moves here (workspace ADR 0001, rule 2). It is a **CPython rule**, and the **compensated sum** is already here. All the places depend on this package, so the move adds no dependency.

## Decision

```ts
NeumaierSum.mean(values: Iterable<number>): number;
// sum(values) / len(values) in CPython 3.12.
// No value: a RangeError, where Python raises ZeroDivisionError.
```

- **The result is `NeumaierSum.of(values)` divided by the number of values.** The division is the float division of JavaScript, which is the division of Python for a count below 2^53.
- **No value throws a `RangeError`.** In Python, `sum([]) / len([])` raises `ZeroDivisionError`. JavaScript has no error for a division by zero, and this package already gives a `RangeError` for a value that Python refuses (`loadsJson` and an int of more than 4300 digits). A mean of no value is a bug in the caller, so the package does not return `NaN` or a value that the caller chooses.
- **The name is `NeumaierSum.mean`.** CPython has no function for this mean, so the name is our name. The name tells the summation, as stdlib-js does (`@stdlib/stats-base-meankbn` is the mean with the improved Kahan–Babuška sum, and `meanpw` is the mean with the pairwise sum). It sits beside `NeumaierSum.of`, the other one-call form. A bare `mean` is not correct: `retrieval-metrics.ts` also imports numpy's `mean` with the pairwise sum, and two functions with the name `mean` in one file give two meanings to one word.
- **The parameter is an `Iterable`, as for `NeumaierSum.of`.** The function counts the values that it adds. Thus `report.ts` gives the values of its `Map`, and no caller gives a count.

### Why not a function of CPython

CPython 3.12 has two means in `statistics`, and neither one is `sum(values) / len(values)` (probe with `uv run --no-project --python 3.12 python -I`):

| Values                                                            | `sum / len`           | `statistics.mean` (exact fractions) | `statistics.fmean` (`math.fsum`) |
| ----------------------------------------------------------------- | --------------------- | ----------------------------------- | -------------------------------- |
| `[0.1, 0.2, 0.3]`                                                 | `0.19999999999999998` | `0.2`                               | `0.19999999999999998`            |
| `[6.999991804172626e-17, 4590793573456045.0, 8602675149153520.0]` | `4397822907536521.5`  | (not compared)                      | `4397822907536522.0`             |
| `[1e308, 1e308, -1e308]`                                          | `inf`                 | (not compared)                      | `OverflowError`                  |
| `[]`                                                              | `ZeroDivisionError`   | `StatisticsError`                   | `StatisticsError`                |

In 20,000 random lists, `sum / len` differed from `statistics.mean` 4,514 times. Thus a port of `sum(values) / len(values)` must not use either function.

## What stays with each consumer

- offers-evals deletes `mean()` from `src/aggregation/mean.ts`. `summarize.ts` (lines 100 and 147) and `leaderboard.ts` (line 59) call `NeumaierSum.mean`. Its message for no value changes to the message of this package. SOB's `arithmetic_mean` and `category_mean` give `0.0` for no row (evaluate.py:735-736 and 749-750), before the division; offers-evals' `mean()` threw, and the switch keeps that.
- `MeanOf` calls `NeumaierSum.mean` on the values of its scorers, and keeps its `Ratio(mean, 1)`. Its constructor takes one scorer or more, `(scorer, ...scorers)`, so a `MeanOf` without a scorer cannot be built. Today such a `MeanOf` gives `NaN`. With `NeumaierSum.mean`, it would throw only when it scores. This change goes to the package that holds `MeanOf` when the switch is built (`@zukhruf/evals` after #3888).
- mteb `retrieval-metrics.ts:293` and `report.ts:202` call `NeumaierSum.mean`. `report.ts` keeps its `pythonRound(…, 5)`. The golden test calls `NeumaierSum.mean` in its `roundedMean`.
- mteb `retrieval-metrics.ts:214` does **not** change. MTEB divides the sum of each list by `len(scores)`, the number of queries (retrieval_metrics.py:519), not by the length of the list. When `k_values` has a value two times, each list has two values for each query, and MTEB gives two times the mean. The port keeps that: it uses `NeumaierSum.of` and `scores.size`, and it keeps its round to 5 digits and its `ZeroDivisionError`.

## What is not the same knowledge

These means stay where they are:

- numpy's mean with the pairwise sum: mteb `src/dependencies/numpy.ts`, and relevance-filtering's `eval/metrics.ts` and `src/statistics.ts`.
- mteb `src/benchmarks/benchmark-metrics.ts`. Its scores are numpy float64 values. CPython 3.12 adds a float without compensation when its type is a subclass of `float`: `sum([F(0.1)] * 10) / 10` gives `0.09999999999999999` for `class F(float)`. So that port uses a plain sum.
- `TokenF1` gives `Ratio(sum, expected)`, with `0` for no leaf. It is a ratio that `Totals` adds (structured-eval ADR 0004), not a mean.
- mteb `report.ts:401`. It is a statistic of the page, and no Python program gives it.

## The weighted mean

offers-evals' `weightedMean` (`src/aggregation/mean.ts:19-29`) gives `sum(v × w) / sum(w)`, and the value of the caller when the weights add up to 0. It is not a **CPython rule**: CPython has no weighted mean of this form, and "0 when the weights add up to 0" is a rule of SOB's scripts (`weighted_mean` of evaluate.py:740-744, and `aggregate()` of scripts/build_leaderboard.py:96-99). So it does not come into this package.

`RatioOfSums` already holds this weighted mean: it adds `new Ratio(value, 1).times(weight)`, which is `Ratio(value × weight, weight)`, and its value is `0` when the whole is `0`. For each list, the result is equal to that of `weightedMean(values, 0)` to the last bit: each part is `value × weight` and each whole is `weight`, and both sums are a `NeumaierSum`. offers-evals gives `0` in its two calls (`policy.ts:68` and `:138`). offers-evals already depends on the package that exports `RatioOfSums`. So offers-evals deletes `weightedMean` and its `whenNoWeight` constants, and uses `RatioOfSums`. This is not an extraction at strike 2: the code is already a public API, and the use of it removes a copy.

## Golden values

`generate.py` gives a `mean` to each case of `sums`: the bits of `sum(values) / len(values)`, or `"ZeroDivisionError"` for the empty case. A second table of cases is not necessary. The cases of `sums` already prove these facts:

- `[0.1] * 10` gives `0.1`. Plain JavaScript addition gives `0.09999999999999999`.
- `[1e16, 1.0, -1e16]` gives `0.3333333333333333`. Plain JavaScript addition gives `0`.
- `[0.1, 0.2, 0.3]` gives `0.19999999999999998`, not the `0.2` of `statistics.mean`.
- `[1e308, 1e308, -1e308]` gives `inf`, where `statistics.fmean` raises.
- `[-0.0]` gives `0.0`, and `[]` raises `ZeroDivisionError`.
- The cases with `nan` and `inf` give `nan` and `inf`. The 200 random cases give a mean each.

`generate.py` adds one case to `sums`: `[6.999991804172626e-17, 4590793573456045.0, 8602675149153520.0]`. Its mean `4397822907536521.5` is not that of `statistics.fmean`, so the test proves that the mean does not use `math.fsum`.

## Considered Options

- Keep the copies. Each fix then needs five edits, and the copies already differ for no value (a `RangeError` or `NaN`).
- A function `mean(values)`. Two meanings of one word in `retrieval-metrics.ts`.
- A value for no value that the caller gives. Python has no such value, and the places that gave `NaN` did so by accident.
- `NeumaierSum.mean(values)`, which throws a `RangeError` for no value. This option was selected.

## Consequences

- A port that takes the mean of floats as `sum(values) / len(values)` calls `NeumaierSum.mean`.
- CPython 3.12 adds an int that comes after a float without compensation: `sum([1e16, 1, -1e16])` gives `0.0`, and `sum([1e16, 1.0, -1e16])` gives `1.0`. A JavaScript number does not tell an int from a float. So the mean is that of Python only for floats, as for `NeumaierSum.of`.
