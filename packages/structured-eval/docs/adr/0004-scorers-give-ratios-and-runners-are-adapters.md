# Scorers give ratios, a ratio of sums adds them, and runners are adapters

Ezz expects to write his own eval framework, and promptfoo is the runner today. The first core had one function for many jobs: `score()` walked the records, counted, checked for a perfect record and listed the differences, and the promptfoo binding built the named scores. A change to one metric changed the function that computes all of them, and the binding held scoring rules.

The core is now a standard that does not know any runner:

- A scorer scores one stated record against its case and gives a scorecard: passed, reason, checks and named ratios. A ratio keeps its part and its whole, not only their quotient.
- A ratio of sums adds ratios. Each average of the package is one: a micro average adds Ratio(right, expected), a mean adds Ratio(value, 1), and a weighted mean adds Ratio(value × weight, weight). The sums use Neumaier's compensated summation, as the sum() of CPython 3.12 does.
- A gate multiplies a measure inside the scorer, for each record. A gate on the averages would give mean(a) × mean(b), not mean(a × b).
- A runner is an adapter. The promptfoo adapter gives each ratio as a named score with its whole as the weight. promptfoo adds value × weight, so it shows the same ratio of sums.
- Each part is a small object with one job: an alignment, a comparator, a match, a measure, a gate. A scorer keeps no result: it makes new measures for each record.
- `scoring/` and `aggregation/` import nothing from `records/` or `paths/`.

Precedents:

- torchmetrics: summed state with update and compute, `MeanMetric(value, weight)`, `BootStrapper` as a wrapper, and operators that work on the averages.
- Inspect AI: a scorer gives named values and an explanation, and metrics reduce lists of scores.
- AWS Stickler: a comparator for each field, a Hungarian matcher, one class for each calculation, and a bulk evaluator in the torchmetrics style.
- scikit-learn: a micro average adds the counts first.

Rejected: DeepEval keeps results on the metric object. @deepagents/evals gives one 0–1 score for each scorer and a plain mean.

## Considered Options

- One function for each scorer, and a binding that builds the named scores. It mixes jobs, and a runner change touches the scoring.
- An abstraction of promptfoo. A second runner would get the shape of promptfoo.
- A standard of scorers, scorecards and ratios, with runners as adapters. This option was selected.

## Consequences

- Ezz's own runner adds scorecards with `Totals`. The core does not change for it.
- `scoring/` and `aggregation/` move to their own package when a second package scores with them (workspace ADR 0001, rule 2).
- A scorecard holds ratios, not counts by name. A count is the part or the whole of a ratio.
