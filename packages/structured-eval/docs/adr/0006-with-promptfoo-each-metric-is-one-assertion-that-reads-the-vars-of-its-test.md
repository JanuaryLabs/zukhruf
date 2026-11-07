# With promptfoo, each metric is one assertion that reads the vars of its test

Status: amended by [ADR 0011](0011-one-comparison-core-alignment-per-array-and-sob-is-a-configuration.md) (accepted 2026-11-06). `JsonPair` is replaced by `Comparison`, and `JsonTextCase` is replaced by `TextVarsCase`. One assertion for each scorer, with the case from the vars of the test, stays.

Status: amended by [ADR 0009](0009-a-scorer-gives-a-value-for-one-answer-and-a-metric-adds-many.md). Its words changed: a metric of this ADR is a scorer now, a scorer is a scorecard scorer, `MetricScorer` is `ScorerSet`, `MetricAssertion` is `ScorerAssertion`, and `CanonicalEquality` is `ExactMatch`.

ADR 0005 says that one metric can be one promptfoo assertion: `PromptfooAssertion` adapts a `MetricScorer` that has one metric. The offers-evals repository used that form for the metrics of the Structured Output Benchmark (SOB), and the form has two faults:

- It reads the case from the config of the assertion. One assertion in `defaultTest` serves every test of a dataset, so it has one config for all of them. promptfoo's docs say that an assertion in `defaultTest` reads the values of each test from its vars: "Use regular column names (like reference_answer) instead of __expected when referencing values in defaultTest assertions" (configuration/test-cases).
- It gives a grading result whose pass is "every value is 1". The `threshold` of the assertion cannot change that pass. For SOB, a test passes when its stated value is valid JSON, and its other metrics pass at any value.

`MetricAssertion` adapts one metric. It reads the case from the vars of the test with a case reader, such as `JsonTextCase`, and it gives the value of the metric as a number. The config of the assertion does the rest, as promptfoo 0.125.1 does for a number:

- `metric` names the value. The column header shows its mean over the tests.
- `weight` sets how much the value counts in the score of the test. promptfoo divides the sum of value × weight by the sum of the weights. A weight of 0 keeps the named value but takes it out of the score of the test.
- `threshold` sets when the assertion passes: when the number reaches it, or when the number is above 0 without one. The test passes when all its assertions pass.

So the YAML holds the composition of a benchmark: its names, its weights and its pass rule. The metric classes hold no runner rule.

`JsonTextCase` reads `expected` as JSON text and `schema` as a JSON value. Text keeps `7.0` a float, as `json.loads` reads it. promptfoo resolves a `$ref` in the vars of a row to a JSON value, and SOB's prompt prints the schema of each row from that value (`dump(2)`).

Precedents: promptfoo gives one assertion for each check (`is-json`, `contains`), with `metric`, `weight` and `threshold` on each. Inspect AI gives one scorer for each value.

This ADR replaces the sentence of ADR 0005 that says one metric is a `PromptfooAssertion` of a `MetricScorer`.

## Considered Options

- `PromptfooAssertion` of a `MetricScorer` with one metric. It reads the config, and its pass rule is fixed.
- One assertion that gives all the metrics of a benchmark as named scores. One function then holds every metric, and a change to one metric changes the function of all of them.
- `MetricAssertion`: one metric, its case from the vars, and its value as a number. This option was selected.

## Consequences

- `PromptfooAssertion` stays for a scorer that gives a scorecard, such as `RecordScorer`. Its ratios keep their wholes as weights, so the header shows a micro average. A `MetricAssertion` value is one value for one test, so its header shows the mean over the tests.
- Each `MetricAssertion` reads the stated value and the case again. Many assertions of one test can share one `JsonPair` when a caller has more than one of them.
- A schema value comes from promptfoo's parse, so a `const` or `enum` number in it is read as JavaScript reads it: `7.0` is `7` there.
