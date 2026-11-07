# A scorer assertion reaches promptfoo as a file reference to a function of its assertion module

Status: Accepted 2026-11-07 by Ezz (backlog #3905). It amends [ADR 0007](0007-a-metric-assertion-is-a-promptfoo-assertion-object-in-a-typescript-config.md): the assertion object with a function `value` goes out of the config. A TypeScript config and one assertion for each scorer stay.

## Context

ADR 0007 put each `ScorerAssertion` object in the `defaultTest` of a TypeScript config. Its `value` is a function. Since ADR 0012, a test generator also puts the scorer assertions of a subset in the `assert` of each test.

promptfoo stores the config of an eval as JSON. A function does not survive JSON. The stored assertion keeps `type`, `metric`, `weight` and `threshold`, but it has no `value`.

`promptfoo eval --resume` and `promptfoo eval --retry-errors` do not read the config file again. They build the run from the stored config:

- `--resume` calls `resolveReplayConfigs(resumeEval)` (promptfoo 0.125.1, `dist/src/main.js:4843-4849`).
- `--retry-errors` calls the same function (`main.js:4850-4866`).
- `resolveReplayConfigs` uses `evalRecord.config` (`main.js:4670-4688`). The branch that reads a config file (`main.js:2693-2701`) does not run, because the command has no config path.
- An assertion with no `value` fails in `handleJavascript`: "javascript assertion must have a string value" (`dist/src/evaluator-BxCmvGtv.js:2657`). promptfoo catches the error and gives the assertion the score 0.

promptfoo's docs say that `--retry-errors` "uses the original eval's configuration" (usage/command-line). promptfoo warns about it at load time: "Tests from dataset.ts contain function values that cannot be saved for resume/retry. Use file:// references for executable test fields." (`main.js:1606`). It gives no warning for `defaultTest`.

A repro confirmed the defect (backlog #3905). It used 4 SOB records (2 text, 1 image, 1 audio), 2 replay providers (8 rows), the real `defaultTest` of offers-evals (10 scorer assertions) and one scorer assertion for each test:

| Run                                      | Rows scored                                | Overall, thinking off |
| ---------------------------------------- | ------------------------------------------ | --------------------- |
| Baseline                                 | 8 of 8                                     | 0.9103                |
| Killed after 2 rows, then `--resume`     | 2 of 8                                     | 0.3041                |
| One failed row, then `--retry-errors`    | the retried row scores 0 on all 11 metrics | 0.2348                |
| File references, killed, then `--resume` | 8 of 8, equal to the baseline              | equal                 |

The resumed rows did not show as errors. They failed as assertion failures with 0 on every metric, so the summary read them as real values. The `afterEach` hook of offers-evals scores only rows with an error, so it did not find them.

## Decision

A config holds only JSON. Each scorer assertion reaches promptfoo as a promptfoo `javascript` assertion whose `value` is a file reference: `file://<module>:<name>`. promptfoo loads the function `<name>` from `<module>` when it grades, on the first run and on a resumed run alike.

The package gives this with one class, `AssertionModule`:

```ts
// evals/scorers.ts: the module that promptfoo loads
export const scorers = new AssertionModule(import.meta.url, {
  valid_json: new ScorerAssertion(new SchemaCompliance(), { weight: 1, threshold: 1 }),
  field_recall_text: new ScorerAssertion(truth.text, { metric: 'field_recall', weight: 1, threshold: 0 }),
});
export default scorers.functions;

// evals/promptfooconfig.ts
defaultTest: { assert: scorers.assert('valid_json') },
```

- `new AssertionModule(url, assertions)` takes the URL of the module that holds it (`import.meta.url`) and the scorer assertions by name.
- `functions` holds the `value` function of each scorer assertion under its name. Its keys are strings, because promptfoo reads a function by the name in its reference. `assert` holds the type of each name. The module gives it as its default export. promptfoo reads `file://<module>:<name>` on the default export of the module when the module has one (`importModule`, `dist/src/esm-B4NX_h4K.js:205-224`: `mod = default ?? module`, then `mod[name]`).
- `assert(...names)` gives a promptfoo assertion for each name: `{ type: 'javascript', metric, weight, threshold, value: 'file://<path>:<name>' }`. The names are a union type, so a name that the module does not have is a compile error.
- The name is the promptfoo metric unless the scorer assertion gives its own `metric`. Several scorer assertions can report one metric. This is how the scorers of each subset report under one metric.
- `ScorerAssertion` is not a promptfoo assertion now. It has no `type` and no name. It holds the scorer, `weight`, `threshold`, an optional `metric`, and its `value` function. A config that lists a `ScorerAssertion` directly does not type-check against `UnifiedConfig`, because a promptfoo assertion needs a `type`.

The name, the weight and the threshold have one source: the scorer assertion. The config writes only names.

A probe confirmed the default-export form with promptfoo 0.125.1: a module with `export default functions`, names from data and not from export syntax, one row that fails on its first call, and `--retry-errors` run from another folder (`/`). The retried row got all its named scores.

The test `src/promptfoo/assertion-module.test.ts` runs the real promptfoo CLI (a devDependency of the package, 0.125.1, as in its consumers) in a temporary `PROMPTFOO_CONFIG_DIR`. Its provider fails one row on its first call. After `promptfoo eval --retry-errors`, the test reads the named scores of the retried row. `--resume` uses the same `resolveReplayConfigs`, so the test covers it too.

## Considered options

- **An interim rule: never resume; score the stored answers again.** The defect stays. A person who resumes a run of 1-3 days gets a wrong summary and no error.
- **`promptfoo retry <evalId> -c <config>`.** It reads the config file again (usage/command-line: "uses original eval config if not provided"). It covers retry only. `--resume` has no such option.
- **Named ESM exports and hand-written references** (the form of the repro): `export const valid_json = …value` and `{ metric: 'valid_json', weight: 1, threshold: 1, value: 'file://scorers.ts:valid_json' }`. It works, but it writes each name, weight and threshold twice. ADR 0007 rejected this form for that reason.
- **One function for each score that reads the subset from `context.test.metadata`.** One reference serves every subset. But the function picks its scorer from untyped test data at run time, and the package must read `context.test`, a need of one host. ADR 0012 decided that the caller gives each test the scorers of its subset. This option was rejected.
- **The assertion `config` field** (`{ value: 'file://…:field_recall', config: { subset: 'text' } }`). It has the same faults as the option above.
- **Ask promptfoo to read the config file again on resume.** promptfoo's design stores the config so that a resumed run is the same run. It is not in our control, and it is not a fix for this package.
- **`AssertionModule`: one module, names from data, the default export as the functions.** This option was selected.

## Consequences

- A stored result shows each `value` as its file reference, not as `null`. This replaces the first consequence of ADR 0007.
- The promptfoo warning at `main.js:1606` does not show for a test generator that uses `assert(...)`.
- The module that holds an `AssertionModule` must give `functions` as its default export. Without it, promptfoo finds no function, and the first run fails each row with "Assertion malformed". The failure is loud on the first run, so it cannot hide in a resumed run.
- A module with a default export cannot also give a test generator: promptfoo reads `file://…:load` on the default export too. The scorers and the test generator stay in different modules.
- The reference holds the absolute path of the module. promptfoo also stores the absolute `basePath` of the config (`main.js:2748, 2764`), so the stored eval was already tied to one machine. promptfoo 0.125.1 splits a file reference at its first colon (`evaluator-BxCmvGtv.js:5683-5686`), so an absolute Windows path (`C:\…`) loses its drive. This is a defect of promptfoo.
- `PromptfooAssertion` does not change. It already reaches promptfoo by a file reference to `grade`, with the case in the assertion `config` (startup-credits, `promptfoo/assertions/offers.ts`).
- The `afterEach` hook of offers-evals runs the assertions of the test with `assertions.runAssertions`. promptfoo loads file references there too, so a failed row gets its named scores on a retried run as well.
- CONTEXT.md: **Scorer assertion** becomes "A scorer with its weight, the threshold at which it passes, and the metric it reports under. An assertion module gives it to promptfoo." A new entry, **Assertion module**: "The module that promptfoo loads the function of a scorer assertion from. A config names its scorer assertions, and gets JSON assertions with file references."

## Precedents

- promptfoo's own warning (`main.js:1606`): "Use file:// references for executable test fields."
- promptfoo's docs for the javascript assertion: "You can specify a particular function to use by appending it after a colon" (configuration/expected-outputs/javascript).
- Node's `createRequire(import.meta.url)` and `new URL('./x', import.meta.url)`: a module gives its own URL to an API that must find files from it.
- ADR 0012: the caller gives each test the scorers of its subset. One name for each subset keeps this.

The name `AssertionModule` is ours. promptfoo has no word for the module of assertion functions; its docs say "a JavaScript file" with "a particular function".
