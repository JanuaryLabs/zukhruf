# The caller gives the bootstrap its interval, and @zukhruf/statistics draws it

`Bootstrap` gave the interval of SOB's `percentile_bounds`: the estimates at floor(0.025(n − 1)) and ceil(0.975(n − 1)), and `[0, 0]` for no scorecards. Those are SOB's choices, and ADR 0005 keeps a benchmark's choices in its caller. Five other places also computed a percentile interval of a bootstrap, so the loop and the quantile methods moved to `@zukhruf/statistics` (its ADR 0001, backlog #3819).

`Bootstrap` now takes the number of resamples, a random index (`(n) => random.randrange(n)` for CPython's `random.Random`), and a `ConfidenceIntervalMethod` of `@zukhruf/statistics`, such as its `PercentileInterval`. It keeps only what this package knows: the statistic, which is the ratio of sums of one name over the scorecards of a resample, each with its weight. `interval` gives a `ConfidenceInterval`. The golden test gives SOB's interval as its own `ConfidenceIntervalMethod`: NumPy's `lower` method at 0.025 and its `higher` method at 0.975, which are SOB's floor and ceil. A percentile interval reads both ends with one method, so SOB's rule stays with SOB's caller.

## Consequences

- Scorecards with no rows throw a `RangeError`. SOB's `[0, 0]` for them was a choice that no caller reached.
- `RandomIndex` is gone. The generator is a function, as `@zukhruf/statistics` takes it.
- This amends line 24 of ADR 0005: a generator works through its `randrange`, given as a function.
