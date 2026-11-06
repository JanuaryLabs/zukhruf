# @zukhruf/structured-eval

A model or a harness gives a structured record, such as the offers of a web page. This package compares that record with the record that a person labelled, field by field. It gives the counts and the micro averages of each field and of all fields. The metrics are the precision, recall and F1 of the right values, the same three for presence, and token F1. When the spec has a JSON Schema, the package also gives validity and type safety. A second family of metrics compares two JSON values leaf by leaf, one metric class at a time. The words are defined in [CONTEXT.md](CONTEXT.md).

The package does not run the model and does not store results. A runner does that. The package has an adapter for promptfoo.

## The parts

| Part        | Job                                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `Scorer`    | Scores one stated record against its case. It gives a `Scorecard`.                                       |
| `Scorecard` | The result for one record: `passed`, `reason`, `checks`, and named `Ratio`s.                             |
| `Ratio`     | A part and a whole, such as 2 right values of 3 expected values.                                         |
| `Totals`    | Adds the ratios of many scorecards, name by name: the sum of the parts divided by the sum of the wholes. |

Two scorers come with the package: `RecordScorer` compares a record with a labelled record, and `MetricScorer` gives the values of the metric classes that you give it. A runner calls a scorer and adds the scorecards. The package has an adapter for promptfoo, and any other runner can call the scorers directly.

## Use it

The package is private: it is not on npm. A repository outside this workspace adds the package folder to its npm workspaces and names the package in its dependencies:

```json
"workspaces": ["../mutex/packages/structured-eval"],
"dependencies": { "@zukhruf/structured-eval": "*" }
```

Build the package in this repository before you install it in the other repository: `npx nx run structured-eval:build`.

## Describe a record

A spec tells the package how to compare two records of one kind.

```ts
import {
  ByBestMatch,
  type Match,
  NumberWithin,
  RecordSchema,
  RecordSpec,
} from '@zukhruf/structured-eval';

class SameSentence implements Match {
  canPair(stated: unknown, expected: unknown): boolean {
    // true when the stated quote and an expected mention are the same sentence
  }
}

export const offerSpec = new RecordSpec({
  schema: new RecordSchema(z.toJSONSchema(offersSchema)),
  arrays: { offers: new ByBestMatch(new SameSentence()) },
  fields: { 'offers[].value.amount': new NumberWithin(0) },
  ignore: [
    'offers[].quote',
    'offers[].span',
    'offers[].mentions',
    'offers[].who',
    'offers[].duration',
  ],
});
```

- `arrays`: the alignment of each array, `new ByPosition()` or `new ByBestMatch(match?)`. An array that the spec does not name pairs by position.
- `fields`: the comparator of each field. The default is `new Exact()`. The others are `new NumberWithin(tolerance)`, `new NormalizedText()` and `new TokenOverlapAtLeast(threshold)`. Your own comparator implements `Comparator`.
- `schema`: optional. See [Validity and type safety](#validity-and-type-safety).
- `ignore`: the fields that the package does not compare.

## Score a record

```ts
import { RecordCase, RecordScorer } from '@zukhruf/structured-eval';

const scorer = new RecordScorer(offerSpec);
const scorecard = scorer.score(stated, new RecordCase(expected));
scorecard.passed; // false: one stated offer has no pair
scorecard.ratios.get('offers[].kind recall'); // Ratio { part: 2, whole: 2 }
scorecard.ratios.get('offers items precision'); // Ratio { part: 2, whole: 3 }
scorecard.reason; // offers: 2 pairs of 2 expected and 3 stated items
```

A scorer keeps no result, so one scorer can score any number of records.

A field counts only when it has a value. null and an absent key both mean "no value":

| Expected | Stated         | Counts                           |
| -------- | -------------- | -------------------------------- |
| value    | the same value | expected, stated, present, right |
| value    | another value  | expected, stated, present        |
| value    | no value       | expected                         |
| no value | value          | stated                           |
| no value | no value       | nothing                          |

The precision of a field is the ratio of its right values to its stated values, its recall is the ratio of its right values to its expected values, and its F1 is the ratio of twice its right values to its stated and expected values.

## Presence and partial credit

A stated value can be wrong but at the correct path. Two metrics give credit for that:

- `presence precision`, `presence recall`, `presence f1`: the present values divided by the stated values, the present values divided by the expected values, and the F1 of the two. A value is present when the expected record and the stated record both have a value at its path. The two values can be different.
- `token f1`: each expected value gets the F1 of the words that its stated value shares with it. A missing value gets 0. A value that is not text becomes its JSON text first. The metric is the sum divided by the expected values.

The package gives both metrics for all fields and for each field. Both are micro averages.

## Validity and type safety

Give the spec the JSON Schema of the record:

```ts
export const offerSpec = new RecordSpec({ schema: new RecordSchema(z.toJSONSchema(offersSchema)), … });
```

The `$schema` keyword of the schema names its draft. Without `$schema`, the package reads the schema as draft 2020-12.

- `valid`: 1 when the stated record agrees with the schema, else 0. Its weight is 1, so the column header shows the share of valid records.
- An invalid record counts as a record that stated nothing. Its expected values stay in the denominators, so its recall is 0. It is not a perfect record. The reason of the scorecard names the schema errors.
- `type safety`: the stated values whose type is the type that the schema gives their path, divided by all stated values. This metric reads the stated record as the harness gave it, so it also shows the type errors of an invalid record.

`valid` reads the whole record. The ignored fields stay out of all other metrics.

## Add up many records

```ts
import { Totals } from '@zukhruf/structured-eval';

const totals = new Totals();
for (const { input, expected } of rows) {
  const testCase = new RecordCase(expected);
  totals.add(scorer.score(await harness(input), testCase), testCase.weight);
}
totals.get('recall').value; // all right values divided by all expected values
```

`Totals` adds the ratios of each name: the sum of the parts divided by the sum of the wholes. So `recall` is the micro recall of the run. A case gives its weight: a record case weighs 1.

## Use it with promptfoo

```ts
// promptfoo/assertions/offers.ts
import { RecordCase, RecordScorer } from '@zukhruf/structured-eval';
import { PromptfooAssertion } from '@zukhruf/structured-eval/promptfoo';

import { offerSpec } from './offer-spec.ts';

export default new PromptfooAssertion(new RecordScorer(offerSpec), RecordCase)
  .grade;
```

A test row gives its expected record in the config of the assertion:

```json
{
  "vars": { "url": "…" },
  "assert": [
    {
      "type": "javascript",
      "value": "file://assertions/offers.ts",
      "config": { "expected": { "offers": [] } }
    }
  ]
}
```

The second argument reads the case from the config of the assertion: `RecordCase.from(config)` reads `config.expected`. The assertion passes when the scorecard passes. Each ratio becomes a named score, with its whole as the weight. promptfoo adds the value × the weight, so the column header shows the same ratio of sums as `Totals`. Each check becomes a component result.

## Metrics

Each metric is a class that gives one value for one stated value and its case. The metrics pair the leaves of the two JSON values by path (`a.b[0].c`), and read numbers as Python's `json.loads` does, so `1` is not `1.0`.

```ts
import {
  AtLeast,
  Gated,
  JsonCase,
  LeafExactMatch,
  MetricScorer,
  PathF1,
  SchemaCompliance,
} from '@zukhruf/structured-eval';

const scorer = new MetricScorer({
  'leaf exact match': new LeafExactMatch({ whenNoneExpected: 1 }),
  truth: new Gated(
    new LeafExactMatch({ whenNoneExpected: 1 }),
    new SchemaCompliance(),
    new AtLeast(new PathF1({ whenNoPaths: 0 }), 0.95),
  ),
});
scorer.score(stated, new JsonCase(expected, schema, 1)).ratios.get('truth'); // Ratio(value, 1)
```

| Metric              | Value for one stated value                                                                                                                                                                                                                      |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ParseSuccess`      | 1 when it is a JSON object or array                                                                                                                                                                                                             |
| `ValidSchema`       | 1 when the schema of the case is a valid Draft 7 schema                                                                                                                                                                                         |
| `SchemaCompliance`  | 1 when it is parsed and agrees with a valid schema                                                                                                                                                                                              |
| `LeafExactMatch`    | the expected leaves that it has at the same path with an equal value (Python `==`); `whenNoneExpected` when the expected value has no leaf                                                                                                      |
| `LeafTokenF1`       | the mean token F1 of each expected leaf and its value at the same path; `whenNoneExpected` when the expected value has no leaf, `whenNoWords` for a leaf where neither value has a word, and a path that it does not have is read as `absentAs` |
| `PathRecall`        | the expected leaf paths that it has; `whenNoneExpected` when the expected value has no leaf                                                                                                                                                     |
| `PathF1`            | the F1 of the leaf paths that both values have; `whenNoPaths` when neither value has a leaf                                                                                                                                                     |
| `LeafTypePrecision` | its leaves whose type the schema allows at their path, by the rules of draft 7; `whenNoneStated` when it has no leaf. It has no gate: a record that the schema accepts gives 1, so it grades a record that the schema refuses (ADR 0008)        |
| `RequiredKeyRecall` | the required paths of the schema that it has; `whenNoneRequired` when the schema requires none. It has no gate: SOB composes `Gated(RequiredKeyRecall, ParseSuccess, ValidSchema)`                                                              |
| `CanonicalEquality` | 1 when its canonical JSON (sorted keys) equals that of the expected value                                                                                                                                                                       |

A gate is a metric whose value is 0 or 1. A gate extends `Gate`: it says what it checks, and `Gate` gives 1 or 0. `Gated(metric, ...gates)` multiplies a metric by its gates for each record, `AtLeast(metric, threshold)` is 1 when the metric reaches the threshold, and `MeanOf(...metrics)` is the mean of some metrics for each record.

With promptfoo, each metric is one assertion. A `MetricAssertion` is a promptfoo assertion object, so a TypeScript config (`promptfooconfig.ts`) lists it in its `defaultTest`. Each one has a name (`metric`), how much it counts in the score of the test (`weight`), and when it passes (`threshold`). Both numbers are required:

```ts
// promptfooconfig.ts
import type { UnifiedConfig } from 'promptfoo';

import {
  AtLeast,
  CanonicalEquality,
  Gated,
  LeafExactMatch,
  PathF1,
  SchemaCompliance,
} from '@zukhruf/structured-eval';
import { MetricAssertion } from '@zukhruf/structured-eval/promptfoo';

const validJson = new SchemaCompliance();
const covered = new AtLeast(new PathF1({ whenNoPaths: 0 }), 0.95);

export default {
  prompts: ['file://prompt.txt'],
  providers: ['openai:gpt-6-luna'],
  defaultTest: {
    assert: [
      new MetricAssertion('valid_json', validJson, { weight: 1, threshold: 1 }),
      new MetricAssertion(
        'field_recall',
        new Gated(
          new LeafExactMatch({ whenNoneExpected: 1 }),
          validJson,
          covered,
        ),
        { weight: 1, threshold: 0 },
      ),
      new MetricAssertion('exact_match', new CanonicalEquality(), {
        weight: 1,
        threshold: 0,
      }),
    ],
  },
  tests: ['file://tests.jsonl'],
} satisfies UnifiedConfig;
```

promptfoo adds the value × the weight of each assertion of a test and divides by the sum of the weights: that is the score of the test. An assertion that gives a number passes when the number reaches its `threshold`. The test passes when all its assertions pass. The column header of a metric shows its mean over the tests.

`MetricAssertion` reads the text of the harness as `json.loads` does, without loss, and keeps text that is not JSON as an unparsed value. It reads the case from the vars of the test with `JsonTextCase`, because an assertion that `defaultTest` shares gets only the vars of each test.

`JsonTextCase.from(vars)` reads `expected` as JSON text and `schema` as a JSON value. A row without a weight weighs 1. promptfoo parses each row, so an integral float such as `7.0` is already `7` in a JSON value. JSON text keeps `7.0` a float, as `json.loads` reads it. promptfoo resolves a `$ref` in the vars of a row to its JSON value when the config gives the file of rows in a list (`tests: [file://tests.jsonl]`):

```json
{
  "vars": { "expected": "{\"a\": 7.0}", "schema": { "$ref": "./schema.json" } }
}
```

`MetricScorer` gives the same values to a runner that adds scorecards. `JsonTextScorer` reads the text of the harness for it in the same way:

```ts
const scorer = new JsonTextScorer(
  new MetricScorer({ 'canonical equality': new CanonicalEquality() }),
);
```

`JsonCase.from(config)` reads `{ expected, schema, weight? }` as JavaScript values.

## Means and intervals

`Totals` gives the mean of each name over many scorecards, without weights (each weight 1) or with them. `Bootstrap` gives its 95% interval: each sample draws as many scorecards as there are, with replacement, from the random generator that you give it.

```ts
import { Random } from 'python-random';

const rows = scorecards.map((scorecard, index) => ({
  scorecard,
  weight: weights[index],
}));
new Bootstrap(new Random(42), 1000).interval(rows, 'truth'); // [low, high]
```

The metric classes port the metrics of the Structured Output Benchmark (SOB), evaluate.py at commit da785a8. The golden test composes SOB's report from them (its labels, categories, weights and seeds) and proves that it gives the numbers of evaluate.py, record by record, with the same means and intervals. Do not compare these metrics with the micro averages of the record scorer.

## Documentation

- [ADR 0001: the package is private and is reached through a workspace path](docs/adr/0001-the-package-is-private-and-is-reached-through-a-workspace-path.md)
- [ADR 0002: set items pair by maximum matching, and the metrics are micro averages](docs/adr/0002-set-items-pair-by-maximum-matching-and-the-metrics-are-micro-averages.md)
- [ADR 0003: SOB parity is a separate, lossless port of evaluate.py](docs/adr/0003-sob-parity-is-a-separate-lossless-port-of-evaluate-py.md)
- [ADR 0004: scorers give ratios, a ratio of sums adds them, and runners are adapters](docs/adr/0004-scorers-give-ratios-and-runners-are-adapters.md)
- [ADR 0005: metrics are classes named by what they measure, and a benchmark is a composition kept by its caller](docs/adr/0005-metrics-are-classes-named-by-what-they-measure.md)
- [ADR 0006: with promptfoo, each metric is one assertion that reads the vars of its test](docs/adr/0006-with-promptfoo-each-metric-is-one-assertion-that-reads-the-vars-of-its-test.md)
- [ADR 0007: a metric assertion is a promptfoo assertion object in a TypeScript config](docs/adr/0007-a-metric-assertion-is-a-promptfoo-assertion-object-in-a-typescript-config.md)
- [ADR 0008: type precision follows JSON Schema draft 7 and has no gate](docs/adr/0008-type-precision-follows-draft-7-and-has-no-gate.md)

## Development

`npx nx run structured-eval:typecheck` and `npx nx run structured-eval:build`.
