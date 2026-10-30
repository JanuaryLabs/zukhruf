# Code copied from the information-filtering evals

The paired bootstrap test of this package (`src/significance/paired-bootstrap.ts`) compares the scores of a change and its baseline query by query. The evals of `@zukhruf/relevance-filtering` and `@zukhruf/event-detection` (`packages/information-filtering/`) already compare two designs with a bootstrap and a verdict. This package keeps its own copy of four parts of them, and does not share them yet.

The reason is the Rule of Three (workspace ADR 0001, rule 2). Each part is counted by what it knows, and this package is the second place for each part. A third place that bootstraps paired differences with NumPy's generator, a third port of `numpy.random.default_rng`, or a third three-way verdict on an interval starts the extraction (backlog #3411). The three working copies then give the boundary of the shared code. Until then, make each fix in all copies, and name the files in the commit.

Paths on the left are in `packages/information-filtering/`. Paths on the right are in `packages/mteb/src/`.

## Copied without changes

- `relevance-filtering/eval/numpy-random.test.ts` → `dependencies/numpy-random.test.ts`: the integers of `numpy.random.default_rng` for two seeds.

## Copied with changes

**`relevance-filtering/eval/numpy-random.ts` → `dependencies/numpy-random.ts`.**
Both give `numpy.random.default_rng(seed).integers(low, high, size)` bit for bit: SeedSequence, PCG64 and Lemire's bounded integers.
Changes: the first comment names the paired bootstrap test of this package, not the research code and the exam rule of the eval. The code is the same.

**`relevance-filtering/eval/bootstrap.ts` `percentile` → `dependencies/numpy.ts` `percentile`.**
Both give `np.percentile` with the method `linear` for sorted values, with the two formulas of NumPy's `_lerp`.
Changes: none. Both calculate the position as NumPy does, `(n - 1) * (q / 100)` (`q` divided by 100 first, then the `get_virtual_index` of `linear`). The eval calculated `((n - 1) * q) / 100` until #3412: for 2000 values and `q` 97.5, that gives 1949.025, and NumPy gives 1949.0249999999999. The golden test of each copy has an array of 2000 values at 97.5 that shows the difference.

**`relevance-filtering/eval/bootstrap.ts` `topicBootstrap` → `significance/paired-bootstrap.ts` `pairedBootstrapTest`.**
Both draw as many units as there are, with replacement, with `generator.integers(0, n, n)` for each replicate, take the mean of the differences of each draw, and give the 2.5 and 97.5 percentiles of the sorted means.
Changes: the units are queries, not profiles. The differences come from two maps of scores by query id, in the Python order of the sorted ids, and the function refuses two maps with different queries. The mean is NumPy's pairwise mean of `dependencies/numpy.ts`; the eval adds the values in a plain loop. The number of replicates and the seed are options, with the defaults of the eval (2000 and 31957). The function also gives the result, the number of queries, the replicates and the seed.

**`event-detection/eval/verdict.ts` (lines 31-33) → `significance/paired-bootstrap.ts` `pairedBootstrapTest`.**
Both give one of three results from the interval of a difference: above 0, below 0, or neither.
Changes: the results are `better`, `worse` and `inconclusive`, not `pass`, `fail` and `inconclusive`. There are no baselines and no regression sets.

## Not copied

The article bootstrap of the relevance-filtering eval (`articleWeights`, `articleBootstrap`), the block bootstrap and the Mulberry32 generator of the event-detection eval, and the roles, answer keys and runners of both evals. They are about frozen designs and their labelled sets, and this package has neither.

## Backlog

#3411 waits for a third place. Its interim rule: mirror every fix in all copies, and name the files in the commit.
