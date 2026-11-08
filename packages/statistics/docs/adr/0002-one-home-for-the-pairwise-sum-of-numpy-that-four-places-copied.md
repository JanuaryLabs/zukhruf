# One home for the pairwise sum of NumPy that four places copied

An eval that must give the numbers of a Python program must add its values in the order of `numpy.sum`. This order is the pairwise sum (`pairwise_sum` of NumPy's `loops_utils.h`). A sum from left to right gives other last bits for 12 of the 17 random arrays of the golden test. Four places copied this sum (backlog #3969, 2026-11-07):

| Place                                                            | How it added                                   |
| ---------------------------------------------------------------- | ---------------------------------------------- |
| `@zukhruf/mteb` `dependencies/numpy.ts`                          | `0 + gsumpw`, and the mean                     |
| `@zukhruf/relevance-filtering` eval `metrics.ts`                 | `0 + gsumpw`, and the mean                     |
| `@zukhruf/relevance-filtering` `src/statistics.ts`               | the pairwise sum written by hand, and the mean |
| `@zukhruf/evals` `./classification` (`BrierScore` and four more) | `gsumpw`, with no `0 +`                        |

That is more than three places, and workspace ADR 0001, rule 2, moves code into one home at the third place. The reference is NumPy, not CPython, so the home is this package, which already holds the quantile methods of NumPy.

The package takes the identical parts, with NumPy's names:

- `sum` is `0 + gsumpw`. `gsumpw` of `@stdlib/blas-ext-base-gsumpw` adds in the order of `pairwise_sum`. NumPy starts its sum from the identity 0, so values of −0 give 0. The golden test proves this with NumPy 2.5.4.
- `mean` is `sum` divided by the number of values.

The golden test found two copies that gave other bits than NumPy. Both differ only for values of −0:

- The hand-written sum of relevance-filtering gave −0 for 8 and 200 values of −0. NumPy gives 0.
- `gsumpw` with no `0 +` (evals) gave −0 for 1, 7, 8 and 200 values of −0. NumPy gives 0.

No golden test of mteb, relevance-filtering or evals changed its expected values.

These parts stay with each caller, because each caller has its own rule:

- the `nanMean` of the relevance-filtering eval: it removes the NaN values before the mean. `numpy.nanmean` sets them to 0 and adds all values, so its order is not the same. Amended on 2026-11-08 (backlog #3991): `numpy.nanmean` was then in three places, so this package gives `nanmean`, and the eval uses it;
- the population standard deviation (mteb `std`, relevance-filtering `populationSd`): two places;
- `addReduceat` of mteb: each segment is its first value plus the pairwise sum of the other values, with no identity. So mteb still uses `gsumpw`;
- the float32 sums of mteb (`ssumpw`): one place.

## Considered Options

- Write the pairwise sum by hand in this package, with no dependency. Then this package owns a port that stdlib already gives, and one copy (relevance-filtering) already had a defect. This option was rejected.
- Use `gsumpw` in this package. Its dependencies are four small stdlib packages. This option was selected.

## Consequences

- `@zukhruf/statistics` has its first dependency, `@stdlib/blas-ext-base-gsumpw`.
- `./classification` of `@zukhruf/evals` has no optional peer now. A user of `@zukhruf/evals` installs `gsumpw` through `@zukhruf/statistics`, because the core depends on this package.
- relevance-filtering lists `@zukhruf/statistics` as a dependency, because its `src/` uses `sum` and `mean`.
