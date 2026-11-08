# Two runs are compared by a paired bootstrap over their tests

Status: accepted (2026-11-08, backlog #3870). Ezz decided the p-value, and he approved the design on 2026-11-08. The other decisions come from the review of the owner of `@zukhruf/statistics` (session statistics-bootstrap-consolidation, ADR 0001 of that package).

## Context

A caller runs one harness two times on the same tests: once with the baseline model and once with a change, such as another model. The caller then asks: "Is the change better than the baseline on this harness?" Two means side by side do not answer this question. A difference of 0.02 can be noise on 121 tests. promptfoo 0.125.1 shows the two means and has no interval or p-value (probe of 2026-11-06).

Two consumers ask the question:

- context-compiler `apps/startup-credits`, page kinds: three runs of jev-1.14 were right on 113, 112 and 111 of 121 pages (2026-10-31). So one model has more than one run, and a test can have more than one answer.
- offers-evals and startup-credits offers: the metadata of each test holds the identity of its harness (model and a hash of the prompt, the schema and the settings), because "each run is compared with a baseline run" (`promptfoo/providers/program-offers.ts:46-49` of context-compiler).

The core already holds `Scorecard`, `Totals` and `Bootstrap`. `Bootstrap` uses `IidBootstrap` and `PercentileInterval` of `@zukhruf/statistics`. ADR 0001 of `@zukhruf/statistics` keeps each verdict rule with its caller. Here the caller is the core of this package.

mteb's `pairedBootstrapTest` (`packages/mteb/src/significance/paired-bootstrap.ts`) does the same work for retrieval: one difference for each query, 2000 resamples, better, worse or inconclusive, and a p-value. Its caller applies Holm to many verdicts (`packages/mteb/src/report/verdicts.ts`).

## Decision

1. **A run holds the scorecards of one model on many tests.** `Run.add(testId, scorecard, weight)` adds one scorecard. The caller gives the test id, because promptfoo has no stable id: its `repeatGroupId` is a position (`test-${i}-vars-${j}`). Inspect AI calls the key `Sample.id`, and Braintrust calls it the comparison key.
2. **An epoch is one more answer to the same test.** A second `add` of a test id adds one epoch (Inspect AI's word; promptfoo's `repeatIndex`, Braintrust's trial). A run reduces the epochs of a test by the mean, name by name: Ratio(sum of the parts / k, sum of the wholes / k) for k epochs. The test stays the unit of the resample. Miller 2024 (arXiv 2411.00640, §3.1) takes the mean of the K answers of one question, and says that a standard error over the K·N answers is wrong. The weight belongs to the case, so an epoch with another weight is a `RangeError`.
3. **The statistic is the metric of each run on the same resampled tests.** For each resample, the statistic is the ratio of sums of the name over the change run, minus the ratio of sums over the baseline run, on the same tests (Koehn 2004, "Statistical significance tests for machine translation evaluation"). So the observed difference is `Totals` of the change minus `Totals` of the baseline. When each whole is 1 and each weight is 1, it is the mean of the differences of the tests, as in mteb. A paired bootstrap is `IidBootstrap` over the pairs of tests (Efron and Tibshirani 1993; SciPy `bootstrap(paired=True)`).
4. **The two runs must have the same tests.** A test id that only one run has is a `RangeError` that names each such id, as mteb refuses different queries (`paired-bootstrap.ts:51`). A test whose weight is not the same in the two runs is a `RangeError`. A name that one run does not give is an `Error`, as `Totals.get` gives. A scorecard of a test that does not have the name counts as Ratio(0, 0), as `Totals` counts it.
5. **The caller gives the direction.** `higherIsBetter` is required, because a scorecard holds names, not scorers, and `BrierScore` is lower-is-better (`src/classification/brier-score.ts:17`). lm-evaluation-harness gives each metric a `higher_is_better`.
6. **The verdict rule is in this core.** With `higherIsBetter: true`, the change is better when the difference interval is above 0, worse when it is below 0, and inconclusive else. With `higherIsBetter: false`, better and worse change places. The rule uses `isAbove` and `isBelow` of `ConfidenceInterval`, as ADR 0001 of `@zukhruf/statistics` says.
7. **Each verdict has a p-value, and the caller corrects it.** Ezz's decision (2026-11-07): "p-value, caller corrects". The p-value is mteb's two-sided percentile-bootstrap p-value: two times the smaller share of the resample differences that are at or below 0 and at or above 0, at most 1. It does not use the direction. A caller that tests many names applies a correction, such as Holm, as mteb's `verdicts.ts` does. A caller that tests one name does not apply a correction. Dror et al. 2018 (ACL, P18-1128) ask for a correction when one paper tests many hypotheses.
8. **The counts of the tests come with the verdict.** Improvements, regressions and ties count the tests by the sign of their difference, with the direction (Braintrust's `summarize()` gives improvements and regressions). A test whose value is the same in the two runs is a tie. "Ties" is the label of this package. The difference of one test is the value of its change ratio minus the value of its baseline ratio. A ratio whose whole is 0 has the value 0, so each test counts in one of the three.
9. **The generator is an input.** The caller gives `nResamples`, `randomIndex` and the `ConfidenceIntervalMethod`, as `Bootstrap` takes them (ADR 0010 of `./structured`). Each resample takes one random index for each test, in the order in which the baseline run first got its tests. The generator keeps its state between calls, so the order of the calls is the order of the draws.

### The class

The class is `PairedBootstrap` of this package, beside `Bootstrap`. `Bootstrap` gives the interval of one name over one run. `PairedBootstrap` gives the verdict of one name over two runs. Its method is `verdict`, because in this package a "test" is one input of the eval, not a hypothesis test. It is not the `PairedBootstrap` of `@zukhruf/statistics` that "Considered Options" rejects: it holds the verdict, the p-value and the join, and it uses `IidBootstrap` as `Bootstrap` uses it.

### The parts that go to `@zukhruf/statistics`, and the parts that stay

The Rule of Three counts the places that have the same knowledge (read 2026-11-07):

| Knowledge                                                    | Places                                                                                                                                                                                                                                                   | Count       | Home                                                                                                   |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------ |
| An interval of a difference, with its observed difference    | mteb `ChangeVerdict` (`observed`, `low`, `high`); relevance-filtering `eval/bootstrap.ts` `Interval`; event-detection `eval/bootstrap.ts` `Interval`; `PairedBootstrap`                                                                                  | 4           | `DifferenceInterval` of `@zukhruf/statistics`, as data only                                            |
| Pair two sets by key, and refuse a key that only one set has | mteb `paired-bootstrap.ts:43-55`; `PairedBootstrap`                                                                                                                                                                                                      | 2           | Strike 2: this core holds a copy of the rule. It is a private step of `PairedBootstrap`, not an export |
| Pair by key, and drop a key that only one set has            | event-detection `eval/bootstrap.ts:109` (`changeOfMainScore` keeps the reports that both partitions hold)                                                                                                                                                | 0 (1 site)  | Another rule, so it does not count. It stays in event-detection                                        |
| Take two arms of one record, with NaN for an absent arm      | relevance-filtering `eval/run.ts:212-218`, `:306-311` and `eval/daily.ts:224-236`: both arms are fields of one record of each profile, so no key can be on one side only. The `?? Number.NaN` only satisfies the type checker. They do not pair two sets | 0 (3 sites) | Another kind, so it does not count. It stays in relevance-filtering                                    |
| The verdict "interval against 0"                             | mteb `pairedBootstrapTest`; `PairedBootstrap`. relevance-filtering's margin of −0.05 and event-detection's rule of two baselines are other rules                                                                                                         | 2           | Strike 2: each caller keeps its rule (ADR 0001 of `@zukhruf/statistics`)                               |
| The two-sided percentile-bootstrap p-value                   | mteb `pairedBootstrapTest`; `PairedBootstrap`                                                                                                                                                                                                            | 2           | Strike 2: each caller keeps it (ADR 0001 of `@zukhruf/statistics`)                                     |

The ledger [docs/copied-code.md](../copied-code.md) records each strike-2 copy (the model is `packages/single-flight/docs/copied-from-mutex.md`). Backlog #4009 waits for "a third consumer". Until then, a fix to one copy goes into the other copy too.

## Considered Options

- **Pool the epochs.** Each answer of each epoch is one item of the resample. Rejected: the answers of one test are not independent, so the interval is too narrow. Miller 2024 §3.1 shows this.
- **A `PairedBootstrap` wrapper in `@zukhruf/statistics`.** Rejected by the owner of that package: a paired bootstrap is `IidBootstrap` over the pairs. `IidBootstrap` already draws one index for each item of each resample, in order. A wrapper adds an API and no knowledge.
- **A verdict method on `DifferenceInterval`.** Rejected: ADR 0001 of `@zukhruf/statistics` keeps each verdict rule with its caller, and the rules differ (mteb, relevance-filtering, event-detection). `DifferenceInterval` is data: `observed`, `low` and `high`, with `isAbove` and `isBelow` of `ConfidenceInterval`.
- **An interval only, with no p-value.** Braintrust, Inspect AI and lm-evaluation-harness give no p-value when they put two runs side by side. Rejected by Ezz on 2026-11-07: a caller that tests many names needs a p-value to apply Holm.
- **A p-value that the core corrects.** Rejected by Ezz on 2026-11-07: the core sees one name for each call, and only the caller knows how many names it tests.
- **The join in the promptfoo adapter or in each consumer.** Rejected in the premise update of #3870: the join reads scorecards, and the core holds them. The adapter and the consumers give the scorecards.

## Out of scope

- Clustered tests, such as many questions about one page. They need a cluster bootstrap (Miller 2024 §2.2; Inspect AI `stderr(cluster=...)`). ADR 0001 of `@zukhruf/statistics` waits for a third place.
- A reducer other than the mean, such as `pass_at_k` or the maximum. Such a reducer changes the metric, not the paired bootstrap.

## Consequences

- startup-credits' page kinds add each of the three runs of one model as an epoch of one `Run`. The difference of a test is then a mean of 0/1 values (#3882, slice 2).
- offers-evals and startup-credits offers compare a run with the baseline run of its harness (#3870, #3882).
- `Bootstrap` and `Totals` can give two different numbers for one name. `Bootstrap` resamples the value of each scorecard over 1 (`src/scoring/bootstrap.ts`, `#mean`): that is the samples average. For a plain scorer, `Totals` gives the micro average. So for a plain scorer, the interval of `Bootstrap` is not the interval of the number of `Totals`. `PairedBootstrap` uses the statistic of `Totals`, so its interval and its observed difference agree. One place shows the two numbers side by side: the SOB golden test (`src/structured/scoring/sob.golden.test.ts:315-329`) shows the mean of `Totals` with the interval of `Bootstrap`. Each SOB scorer is `SampleAveraged`, so there the two numbers agree. No other report shows them together (search of 2026-11-07 in mutex, offers-evals and context-compiler). So no defect is filed.
