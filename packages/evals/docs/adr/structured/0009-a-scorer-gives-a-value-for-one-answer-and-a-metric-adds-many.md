# A scorer gives a value for one answer, and a metric adds the values of many answers

Status: amended by [ADR 0011](0011-one-comparison-core-alignment-per-array-and-sob-is-a-configuration.md) (accepted 2026-11-06). `Scorer.score` reads a `Comparison` and gives a `Ratio`, the scorers are in `src/scorers/`, and a `ScorerSet` passes when each of its gates holds.

The package has three levels. A class such as `PathRecall` gives one number for one answer. `Totals` and `Bootstrap` add the numbers of many answers. An assertion connects a class to promptfoo. Before this ADR, the package called the first level a metric, as lm-evaluation-harness and DeepEval do. Ezz asked what the words mean ("I want to build lib of scoreres/metrics/assertion (not really sure what they are)", 2026-11-04). On 2026-11-06 he saw how widely used tools name the levels, and he chose the words of Inspect AI ("Inspect AI camp").

How the tools name the levels (their source, read on 2026-11-06):

| Tool                  | One answer                      | Many answers                                                          | Connection to the runner |
| --------------------- | ------------------------------- | --------------------------------------------------------------------- | ------------------------ |
| Inspect AI            | `@scorer` gives a `Score`       | `@metric`: `mean`, `stderr`, `bootstrap_stderr`                       | `Task(scorer=)`          |
| Braintrust autoevals  | scorer                          | summary                                                               | `Eval({ scores })`       |
| promptfoo             | assertion                       | the `metric` of an assertion: promptfoo shows its mean over the tests | `assert:`                |
| lm-evaluation-harness | metric                          | aggregation                                                           | `metric_list`            |
| DeepEval              | `BaseMetric.measure(test_case)` | none                                                                  | `evaluate(metrics=)`     |

## Decision

- A scorer gives one number for one stated value and its case: the interface `Scorer`, with `score(pair)`. It was `Metric`, with `of(pair)`. The scorer classes are in `src/paths/scorers/`.
- A scorecard scorer gives a scorecard for one stated record: `ScorecardScorer<Case>`. It was `Scorer<Case>`. In Inspect AI, a scorer can give a score with many named values, and this package calls those values a scorecard. The name joins two words of this package. It is not an industry term.
- A scorer set holds labelled scorers and gives a scorecard: `ScorerSet`. It was `MetricScorer`. The name is the package's own. Inspect AI's `multi_scorer` reduces many scorers to one value, so its name does not fit.
- A scorer assertion connects one scorer to promptfoo: `ScorerAssertion`. It was `MetricAssertion`. Its `metric` field keeps its name: promptfoo reads it, and promptfoo's metric is the mean over the tests, which is a metric in the sense of this ADR.
- A metric adds the values of many records: `Totals` and `Bootstrap`. No class has the name Metric, because each name says what it gives.
- `CanonicalEquality` is `ExactMatch`. Exact match is the one name that the tools share: Inspect AI `exact`, autoevals `ExactMatch`, lm-evaluation-harness `exact_match`.
- The other scorers keep their names (ADR 0005). No tool names path recall, path F1, leaf exact match, leaf token F1, type precision or required-key recall. The names KeyRecall and FieldRecall would clash with the words Path and Field of CONTEXT.md. In autoevals, ValidJSON only parses unless it gets a schema, so it is a bad name for `SchemaCompliance`. Ezz left the class names to an architect review ("I don't mind either just consult sub-agent, architect sub-agent").

## Considered Options

- The words of lm-evaluation-harness and DeepEval: a metric gives the value of one answer. That was the old state. promptfoo and Inspect AI use the word metric for many answers.
- The words of Inspect AI. This option was selected.

## Consequences

- ADRs 0004 to 0008 keep their old words. Each one has a status line that names this ADR.
- offers-evals uses `ScorerAssertion` and `ExactMatch`. Its assertion names, such as `key_recall`, stay: they are the names of its metrics.
- CONTEXT.md defines Scorer, Scorecard scorer, Scorer set, Metric, Scorer assertion and Leaf.
