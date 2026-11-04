# Metrics are classes named by what they measure, and a benchmark is a composition kept by its caller

The first port of the Structured Output Benchmark (SOB) had one scorer for the whole benchmark: `SobScorer` gave all 11 values and named each one `SOB …`, and `SobLine`, `SobSummary` and a table of SOB's labels lived in the package. A caller could not take one metric, the names told where a metric came from and not what it measures, and the package held one benchmark's format and report although no caller used them. Ezz: "why not indivual metric classes/assertion?" and "why still have sob in the code man?"

Each metric is now its own class, named by what it measures: `ParseSuccess`, `ValidSchema`, `SchemaCompliance`, `LeafExactMatch`, `LeafTokenF1`, `PathRecall`, `PathF1`, `LeafTypePrecision`, `RequiredKeyRecall`, `CanonicalEquality`. A gate is a metric with the value 0 or 1, and `Gated`, `AtLeast` and `MeanOf` compose metrics for each record. `MetricScorer` scores any labelled set of metrics, so one metric can be one promptfoo assertion. `Totals` gives the means, and `Bootstrap` gives the intervals with a random generator that the caller gives.

A benchmark is a composition, and its caller keeps it. SOB's line format, labels, categories, weights and seeds are in the golden test, the only caller. SOB's Truth Score, for example, is `Gated(LeafExactMatch, SchemaCompliance, AtLeast(PathF1, 0.95))`. Two of evaluate.py's names needed no class: its hardening is `SchemaCompliance`, because schema compliance already needs a parsed, structured value, and its structured root is `ParseSuccess`, because only an object or an array counts as parsed.

Precedents: torchmetrics has one class for each metric and no benchmark presets; Inspect AI keeps its benchmarks in a separate repository (inspect_evals) that composes its scorers; DeepEval has one class for each metric; promptfoo has one assertion for each check.

This ADR replaces the parts of ADR 0003 that name `SobScorer`, `SobSummary`, `SobLine` and `SobRunnerScorer`. The rest of ADR 0003 holds: the metrics keep Python's results where Python and JavaScript differ.

## Considered Options

- One scorer for each benchmark, with the benchmark's name on its classes. A caller cannot take one metric, and the package holds presets that no caller uses.
- Metric classes, with each benchmark as a preset in the package. The package then holds one benchmark's labels and format.
- Metric classes named by what they measure, and each benchmark composed by its caller. This option was selected.

## Consequences

- A caller that wants SOB's report composes it, as the golden test does.
- `python-random` is a development dependency: only the golden test draws with it. Any generator with `randrange(stop)` works for `Bootstrap`.
- NOTICE keeps SOB's MIT licence: the metric classes are a port of the functions of evaluate.py.
