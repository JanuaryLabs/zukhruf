# A metric assertion is a promptfoo assertion object in a TypeScript config

ADR 0006 made each metric one promptfoo assertion. Its first form lived in YAML: a YAML config can point only at a file, and promptfoo loads a function from that file. So each metric needed its own file with `export default new MetricAssertion(metric, JsonTextCase).grade`. The YAML then named the same metric a second time (`metric:`), and the constructor took a case reader that has only one right value for vars. Ezz: "it looks ugly".

promptfoo 0.125.1 also reads a TypeScript config (`promptfooconfig.ts` is one of its default config names). In such a config, an assertion is an object, and its `value` can be a function: promptfoo calls it with the text of the harness and the context of the test. A probe of this repo showed that a class instance works as that object, and that rows with `$ref`, an imported `defaultTest` and `file://` extension hooks work in a TypeScript config.

So `MetricAssertion` is now the assertion object: `new MetricAssertion(name, metric, { weight, threshold })` has the fields `type` (`javascript`), `metric` (the name), `weight`, `threshold` and `value`. It reads the case from the vars of the test with `JsonTextCase`, because JSON text keeps `7.0` a float and the other reader does not. `weight` and `threshold` are required: promptfoo's defaults (weight 1, a pass only above 0) would quietly fail a test whose metric is 0 and count reported-only metrics in the score of the test.

An eval keeps its whole composition in one place, the `defaultTest` of its TypeScript config, and `satisfies UnifiedConfig` checks the config against promptfoo's types.

This ADR replaces the parts of ADR 0006 that name `grade`, a YAML assertion and the case-reader argument. The rest of ADR 0006 holds: one assertion for each metric, the case from the vars, and promptfoo's config owns the name, the weight and the threshold.

## Considered Options

- YAML, with one file per metric that exports `grade`. Each metric needs a file, and its name is written twice.
- YAML, with one module of named exports (`file://scores.ts:exact_match`). One file, but each export is still a function and each name is still written twice.
- A TypeScript config whose assertions are `MetricAssertion` objects. This option was selected.

## Consequences

- promptfoo cannot store a function in its results, so a stored result shows the `value` of these assertions as `null`. The viewer cannot show the scoring code.
- `extensions` stay `file://` references: promptfoo's config type allows only strings there.
- `PromptfooAssertion` keeps `grade`: its rows put the case in the config of a per-row assertion, which a JSONL file can only point at by `file://`.
