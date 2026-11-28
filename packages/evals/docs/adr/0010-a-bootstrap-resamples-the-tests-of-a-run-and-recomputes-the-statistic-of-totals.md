# A bootstrap resamples the tests of a run and recomputes the statistic of `Totals`

Status: accepted (2026-11-27, #4234). Ezz first picked a statistic Strategy ("Statistic Strategy"), then asked why the two statistics clashed with a name of `./classification`, and left the call to me ("I trust your recommendation … follow the top performers"). The answer below removes the clash at its root, so this ADR has no Strategy.

Status, 2026-11-28 (#6267, Ezz: rule B): a resample whose drawn tests have no whole has no statistic, where `Ratio.value` gave SOB's 0 and pulled the low end of the interval of a score with many whole-0 tests toward 0. The resample is left out, as R boot's `boot.ci` keeps only the finite statistics, the page's own rule of b56d661c (a ratio of no whole has no value) applied to each resample. `Bootstrap.interval` gives a `BootstrapInterval` of `@zukhruf/statistics` with the count it kept, or `undefined` when no resample has a value; `Ratio#quotient` is the value with no SOB 0. Measured on 2000 resamples of `default_rng(42)`: with 1 of 10 tests with a whole, [0.000, 0.750] became [0.750, 0.750] from 1271 resamples; on a group of 8 pages with 5 empty, [0.000, 1.000] became [0.833, 1.000] from 1949; on a whole run of 94 pages nothing changed. Neither golden fixture draws a whole-0 resample, so both keep their numbers.

Status, 2026-11-27 (#6108): `Run#total(name)` gives the number that this interval belongs to: the ratio of sums of the units of the tests, each the mean of its epochs times its weight. `Run#total`, `Bootstrap` and `PairedBootstrap` compute the unit through one function of `run.ts`. `Totals` of all the scorecards equals `Run#total` only when each test has the same number of epochs.

## Context

`Bootstrap` gives the interval of one name. Its statistic forced each scorecard to `Ratio(value, 1)` times its weight: the mean of the values, the samples average. `Totals` and `PairedBootstrap` add the ratios as the scorers gave them. So for a name per item, such as offers' `values_recall`, where a page with 65 expected values weighs 65 times a page with one, the interval of `Bootstrap` was not the interval of the number of `Totals` (#4234; found on ipay on 2026-11-10: 44/45 exact precision gave [12.3%, 21.1%]).

The average is not the bootstrap's choice. In this package the scorer decides it: `SampleAveraged` gives `Ratio(value, 1)`, "so a ratio of sums of many records is the mean of their values: scikit-learn's average='samples'", and a plain `Recall` gives `Ratio(right, expected)`, a micro average (`RatioOfSums`, ADR 0004). Forcing `Ratio(value, 1)` decided the average a second time, against the scorer, and against structured ADR 0010, which says the bootstrap keeps "the ratio of sums of one name over the scorecards of a resample, each with its weight". A statistic Strategy would have made the same choice a third place to make it, so its two names met the words of `./classification`'s averages.

Probe of 2026-11-27: with `ratio.times(weight)` in place of `Ratio(ratio.value, 1).times(weight)`, the SOB golden test (`src/structured/scoring/sob.golden.test.ts`, the one caller) passes its 4 tests, the intervals without and with weights included, because each score of SOB is `SampleAveraged`.

A run has epochs: offers answers each page 3 times, and on eval-ove of offers-evals 241 of 307 pages give the same `values_f1` in each epoch. The answers to one page are not independent, so the unit of a resample is the test with all its epochs. Inspect AI reduces the epochs of a sample to one score before its metrics and its `bootstrap_stderr` run ("Metrics normally operate on a reduced score view, where epoch scores for each sample are combined into a single score. By default, the reduced view is built with `mean`", https://inspect.aisi.org.uk/metrics.html#reducing-epochs); Miller 2024 ("Adding error bars to evals") clusters by question; `PairedBootstrap` resamples tests and takes the mean of their epochs (ADR 0004, point 2).

## Decision

1. **`bootstrap.interval(run, name)` takes a `Run`.** Each resample draws as many tests as the run has, with replacement, in the order of their first add.
2. **Each test is the mean of its epochs** (`Ratio(sum of the parts / k, sum of the wholes / k)`, ADR 0004, point 2), times the weight of its case.
3. **The statistic is the ratio of sums of those ratios**: the statistic of `Totals`, and of `PairedBootstrap` for one run. The scorer decides the average; the bootstrap never changes a ratio.
4. **A name that no test gives throws an `Error`**, as `Totals.get` does, and **a run with no tests throws a `RangeError`**, as before.

## Consequences

- `WeightedScorecard` goes. SOB's golden test builds a `Run` with one epoch for each record, with its weight, and keeps its numbers.
- The number beside the interval is the same statistic over all the tests. It equals `Totals` of all the scorecards when each test has the same number of epochs.
- A caller of a published version that passes rows gets a type error; the release notes say so.
