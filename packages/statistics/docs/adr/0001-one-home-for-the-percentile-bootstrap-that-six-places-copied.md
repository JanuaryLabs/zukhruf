# One home for the percentile bootstrap that six places copied, reached through a workspace path

An eval gives a mean, and the reader must know how sure it is. Six places in two repositories compute the same answer, a 95% percentile interval: they draw resamples of the data with replacement, compute a statistic of each, sort the results and read two quantiles (backlog #3819, 2026-11-06):

| Place                                                | Statistic                                 | Random generator               | Quantile method               |
| ---------------------------------------------------- | ----------------------------------------- | ------------------------------ | ----------------------------- |
| `@zukhruf/structured-eval` `Bootstrap`               | a weighted ratio of sums                  | CPython `random`, one per item | `lower` and `higher`          |
| offers-evals `percentileBootstrap`                   | the caller's mean or weighted mean        | CPython `random`, one per item | `lower` and `higher`          |
| `@zukhruf/relevance-filtering` eval `topicBootstrap` | the mean of paired differences            | a NumPy `default_rng` port     | `linear`                      |
| relevance-filtering eval `articleBootstrap`          | the caller's, over stratified weights     | the NumPy port, by stratum     | `linear`                      |
| `@zukhruf/mteb` `pairedBootstrapTest`                | the mean of paired differences, and a p   | the NumPy port                 | `linear`                      |
| `@zukhruf/event-detection` eval `pairedBootstrap`    | the caller's, over copies of event blocks | mulberry32, by block           | `inverted_cdf` (nearest rank) |

That is more than three places, and workspace ADR 0001, rule 2, moves code into one home at the third place. Ezz chose the name `@zukhruf/statistics`, a private package, and the switch of all six places in one item (2026-11-06: "@zukhruf/statistics", "Private", "All 6 now").

This package takes the identical parts:

- `IidBootstrap` is the loop of four places: each resample draws one random index for each item, in order, resample by resample. The NumPy port draws `integers(0, n, n)` one index at a time and keeps the unused half of a 64-bit draw between calls, so one index for each call gives the same numbers. The generator is an input, so CPython's and NumPy's draws both stay exact.
- `PercentileInterval` is the step of all six places: sort a copy of the distribution and read two quantiles with one quantile method, as `numpy.percentile` and the percentile method of `scipy.stats.bootstrap` do. It is one `ConfidenceIntervalMethod`, SciPy's `method` of an interval.
- `Lower`, `Higher`, `Linear` and `InvertedCdf` are the four quantile methods that the places use, with NumPy's names. Each place hard-coded its method, and structured-eval hard-coded SOB's bounds against its own ADR 0005. Now the caller gives them.
- SOB reads the low end with the `lower` method and the high end with the `higher` method. No standard interval does that, so the package does not take a method for each end. SOB's two callers write SOB's interval as their own `ConfidenceIntervalMethod`. Ezz: "we are to force consumers to follow us, not the other way around" (2026-11-06).
- `ConfidenceInterval` has `isAbove` and `isBelow`. Ezz asked to move the verdict of an interval into this item ("In this item"), because three places seemed to copy it. The three rules differ. mteb gives better, worse or inconclusive from one difference interval. The eval of relevance-filtering passes a ranker when one interval lies above −0.05 and two lie above 0. The eval of event-detection fails a candidate that does not beat two baselines or regresses on a test set. What they share is the side of a value on which an interval lies, so that is the part that moves. Each rule stays with its caller.

What differs stays with its caller: the random generators, the stratified draw of relevance-filtering (it draws all resamples of one stratum, then the other), the block draw of event-detection, mteb's p-value, and the means (CPython's and NumPy's sums differ).

npm has no package that gives these results (checked on 2026-11-06). No package gives a bootstrap interval. d3-array's `quantileSorted` uses NumPy's `linear` rule, but it gives other bits than NumPy for 1,223 of 12,000 values, and simple-statistics' `quantileSorted` differs for 8,876 of them.

The package is private, and a workspace reaches it through its path, as `@zukhruf/structured-eval` and `@zukhruf/python` are reached. This breaks workspace ADR 0001, rule 8, in the same way as their ADR 0001. relevance-filtering and event-detection are public, but only their eval uses this package, and npm does not ship their eval. So they list it as a development dependency, which npm never installs for their users.

## Considered Options

- Keep the copies. Each fix then needs up to six edits, and the copies already differ in their bounds and in the edge of empty data.
- One function per step, as SciPy and NumPy give them. The workspace builds with objects that have one job each, and arch, a Python bootstrap library, also gives classes (`IIDBootstrap`, `CircularBlockBootstrap`).
- An npm package. None gives these results (above).
- One package with the parts that the places copy, as classes. This option was selected.

## Consequences

- Data with no items throws a `RangeError`. offers-evals already threw, NumPy gives NaN, and structured-eval gave SOB's `[0, 0]`, which no caller reaches.
- A stratified bootstrap or a block bootstrap can move here when a third place needs one.
- When the package must be used outside these repositories, publish it and delete the exception.
