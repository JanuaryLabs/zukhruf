# Structured values: `@zukhruf/evals/structured`

> This page describes the one comparison core of [ADR 0011](adr/structured/0011-one-comparison-core-alignment-per-array-and-sob-is-a-configuration.md) (accepted 2026-11-06).

A model or a harness gives a structured record, such as the offers of a web page. This subpath compares that record with the record that a person labelled. One walk pairs the leaves of the two values, and each scorer gives a `Ratio` for one record. A runner adds the ratios of many records. The words are defined in [CONTEXT.md](../CONTEXT.md).

It does not run the model and does not store results. A runner does that, and `@zukhruf/evals/promptfoo` is the adapter for promptfoo.

## The parts

| Part             | Job                                                                                                      |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| `ComparisonSpec` | The rules to compare two values: the alignment of each array, the comparators, and the excluded fields.  |
| `TreeWalk`       | The comparer of this subpath. It compares a stated value with the expected value of its case.            |
| `Comparison`     | The leaf pairs and the item pairs of one stated value and its case.                                      |
| `Scorer`         | Gives one `Ratio` for one comparison, such as `new Recall(new ValueMatches())`.                          |
| `ScorerSet`      | Of the core. Scores one stated value with labelled scorers. It gives a `Scorecard`.                      |
| `Scorecard`      | The result for one record: `passed`, `reason`, `checks`, and named `Ratio`s.                             |
| `Ratio`          | A part and a whole, such as 2 right values of 3 expected values.                                         |
| `Totals`         | Adds the ratios of many scorecards, name by name: the sum of the parts divided by the sum of the wholes. |

## Use it

`./structured` reads JSON Schema with cfworker's validator and pairs set arrays with the Hungarian algorithm. Those two packages are optional peers of `@zukhruf/evals`, so a user of this subpath installs them:

```sh
npm install @zukhruf/evals @cfworker/json-schema munkres
```

## Compare two values

A spec tells the walk how to compare two values of one kind.

```ts
import {
  ByBestMatch,
  ComparisonSpec,
  type Match,
  NumberWithin,
} from '@zukhruf/evals/structured';
import { type JsonData, toJsonParseValue } from '@zukhruf/python';

class SameSentence implements Match {
  canPair(stated: JsonData, expected: JsonData): boolean {
    const quote = toJsonParseValue(stated);
    const mentions = toJsonParseValue(expected);
    // true when the stated quote and an expected mention are the same sentence
  }
}

export const offerSpec = new ComparisonSpec({
  arrays: { '$.offers': new ByBestMatch(new SameSentence()) },
  fields: { '$.offers[*].value.amount': new NumberWithin(0) },
  exclude: ['$.offers[*].quote', '$.offers[*].span', '$.offers[*].mentions'],
});
```

- `arrays`: the alignment of each array (a Strategy). `new ByPosition()` pairs item 0 with item 0, item 1 with item 1, and so on. `new ByBestMatch(match?)` pairs the items in any order: of all pairings, it takes the one with the most agreeing leaves (the Hungarian algorithm). A `Match` can forbid a pair. An array that the spec does not name pairs by position.
- `comparator`: the comparator of all leaves (a Strategy). The default is `new JsonEquality()`: two values agree when JSON Schema calls them equal, so `1` agrees with `1.0`, and `true` does not agree with `1`. `new PythonEquality()` agrees as Python's `==` does, so `true` agrees with `1`.
- `fields`: the comparator of one field, in place of `comparator`. The package has `new NumberWithin(tolerance)`, `new NormalizedText()` and `new TokenOverlapAtLeast(threshold, { form })`, whose `form` is the arithmetic of its F1 (`CountsForm` when you give none). Your own comparator implements `Comparator`.
- `exclude`: the fields that the walk does not compare.

A field is a path without its item positions, such as `$.offers[*].value.amount`. A `Path` is a list of steps, so `{"a.b": 1}` and `{"a": {"b": 1}}` have different paths.

A key of the spec is a JSONPath query ([RFC 9535](https://www.rfc-editor.org/rfc/rfc9535)) that names one field. The package reads a subset of JSONPath:

- `$` is the root identifier. Each key starts with it.
- `.name` and `['name']` (or `["name"]`) are name selectors. A name selector is one step to a member of an object. Use the bracket form for a name that holds `.`, `[`, `]` or a space, or for an empty name: `$['a.b']` and `$['']`. A quoted name uses the escapes of RFC 9535, such as `\'` and `é`.
- `[*]` (or `.*`) is the wildcard selector. It is one step to each item of an array.

Other JSONPath, such as an index `[0]`, a slice, a filter `[?…]`, a descendant segment `..` or two selectors in one segment, throws a `SyntaxError` when you build the spec.

A label and an explanation write a field in the same form, such as `$.offers[*].kind`. They write a path with an index selector for each position, such as `$.offers[2].kind`. A name that is not a member-name-shorthand gets the bracket form of a Normalized Path (RFC 9535, section 2.7), such as `$['a.b']`. So each field has one text, and that text is also a key of the spec.

The walk reads `JsonData` of @zukhruf/python: an int and a float stay apart, and a dict keeps the order of its keys. A JavaScript value enters through `JsonValue.from(value)`, and JSON text enters through `JsonValue.parse(text)`.

```ts
import { ConfigCase, TreeWalk } from '@zukhruf/evals/structured';

const walk = new TreeWalk(offerSpec);
const comparison = walk.compare(stated, new ConfigCase().from({ expected }));
comparison.parsed; // true: the stated value is an object or an array
comparison.leaves(); // the leaf pairs: each side with its own path and value
comparison.arrays(); // the item pairs of each array
```

A stated value that is not an object or an array is unparsed. It has no stated leaves. null is a leaf.

`compare` reads the stated value itself:

- It reads a text as `json.loads` reads it. A text that is not JSON stays a text, so it is unparsed.
- It keeps a `JsonValue` as it is. Give a text that you already parsed as `new JsonValue(text)`.
- It reads another JavaScript value through `JsonValue.from`.

`JsonValue.from` throws a `TypeError` for a `Map` or a `Set`, at any depth, because `JSON.stringify` loses their entries. A dict of `JsonData` is a `Map`, so give it as a `new JsonValue(data)`.

## Score a comparison

A scorer gives a `Ratio` for one comparison. A scorer keeps no result, so one scorer scores any number of records.

`Precision`, `Recall` and `F1` read the counts of a `Matches`: the hits, the stated and the expected.

| Matches        | Hits                                      | Stated            | Expected            |
| -------------- | ----------------------------------------- | ----------------- | ------------------- |
| `PathMatches`  | the leaf pairs with a value on both sides | the stated leaves | the expected leaves |
| `ValueMatches` | the leaf pairs whose two values agree     | the stated leaves | the expected leaves |
| `ItemMatches`  | the item pairs                            | the stated items  | the expected items  |

```ts
import { F1, Precision, Recall } from '@zukhruf/evals';
import { PathMatches, ValueMatches } from '@zukhruf/evals/structured';

new Recall(new ValueMatches()).score(comparison); // Ratio { part: 2, whole: 3 }: 2 right of 3 expected
new Precision(new PathMatches()).score(comparison); // Ratio { part: 3, whole: 4 }: 3 present of 4 stated
new F1(new ValueMatches()).score(comparison); // a ratio { part: 4, whole: 7 }, with the value 4 / 7
```

`PathMatches` and `ValueMatches` read the same leaf pairs, and each one says only what a hit is (Template Method). `Precision`, `Recall` and `F1` take any `Matches`.

A leaf has no value when its key is absent. `new ValueMatches({ nullIsMissing: true })` also reads a null as no value, on both sides. `PathMatches`, `TokenF1`, `TypePrecision` and the gate `AllMatched` take the same option:

| Expected | Stated         | Counts                        |
| -------- | -------------- | ----------------------------- |
| value    | the same value | expected, stated, path, value |
| value    | another value  | expected, stated, path        |
| value    | no value       | expected                      |
| no value | value          | stated                        |
| no value | no value       | nothing                       |

The ratio of `F1` has the part 2 × hits and the whole stated + expected, so many F1 ratios add up to the micro F1. Its form gives its value (ADR 0003). The default form, `CountsForm`, gives part / whole, as scikit-learn does. `new F1(matches, { form: new PrecisionRecallForm() })` gives 0 with no hits, else 2·p·r/(p + r), the arithmetic of SOB's evaluate.py. That value can differ from part / whole in the last bit.

The other scorers:

| Scorer              | Ratio for one comparison                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TokenF1`           | the sum of the token F1 of each expected leaf and its stated value, over the expected leaves. `whenNoWords` is the value of a leaf where neither value has a word, and `absentAs` is the stated value of a leaf with no stated side. |
| `TypePrecision`     | the stated leaves whose type the schema allows at their path, over the stated leaves, by the rules of the draft of the schema (ADR 0008 for draft 7). It has no gate.                                                                |
| `RequiredKeyRecall` | the required paths of the schema that the stated value has, over the required paths. It reads `properties` and `items` only, as SOB does.                                                                                            |

`TokenF1` reads words as SQuAD's `normalize_answer` does: lower case, punctuation and the articles a, an and the become spaces, and a word is a run of Python's `\w`. A value that is not text becomes its text as Python's `str()` gives it.

`TokenF1` takes a `form`, as `F1` does. The token F1 of each leaf uses it. `CountsForm` is the default. SOB's caller gives `new TokenF1({ whenNoWords: 1, absentAs: null, form: new PrecisionRecallForm() })`, because evaluate.py's `token_f1` is 2·p·r/(p + r).

## Gates

A gate is a scorer whose ratio is 1 of 1 or 0 of 1. A gate extends `Gate` (Template Method): it says what it checks (`holds`) and why it fails (`explain`). A gate is also a penalty, with the factor 1 or 0 (see Penalties).

| Gate               | Holds when                                                                      |
| ------------------ | ------------------------------------------------------------------------------- |
| `ParseSuccess`     | the stated value is an object or an array                                       |
| `ValidSchema`      | the schema of the case is a valid schema of its draft                           |
| `SchemaCompliance` | the stated value is parsed and agrees with a valid schema                       |
| `ExactMatch`       | its canonical JSON (sorted keys) equals that of the expected value              |
| `AtLeast`          | `new AtLeast(scorer, threshold)`: the value of the scorer reaches the threshold |
| `AllMatched`       | every leaf pair agrees and every item has a pair                                |

`new Penalized(scorer, ...gates)` multiplies the part of the ratio by each gate, for each record (Decorator). The whole stays. So an invalid record keeps its expected values in the denominator of recall and its stated values in the denominator of precision:

```ts
const valid = new SchemaCompliance();
new Penalized(new Recall(new ValueMatches()), valid).score(comparison); // Ratio { part: 0, whole: 3 } for an invalid record
```

## Penalties

A penalty is a factor in [0, 1] for one comparison, as BLEU's brevity penalty is. The factor 1 is no penalty. A penalty extends `Penalty` (Template Method): it gives `factor(comparison)`. A gate is the penalty whose factor is 0 or 1.

| Penalty            | Factor                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| a `Gate`           | 1 when the gate holds, else 0                                                                                                         |
| `ShortfallPenalty` | `new ShortfallPenalty(scorer, { target, power })`: `min(1, (value / target) ** power)`, with the value of the scorer; 1 at the target |

`new Penalized(scorer, ...penalties)` multiplies the part of the ratio by each factor, for each record (Decorator). The whole stays. When the product is 1, the ratio of the scorer stays as it is, so an F1 keeps the value of its form. A factor outside [0, 1] throws a `RangeError`.

```ts
const valid = new SchemaCompliance();
const keys = new SampleAveraged(new F1(new PathMatches()), { whenEmpty: 0 });
const soft = new ShortfallPenalty(keys, { target: 0.9, power: 2 });
new Penalized(
  new SampleAveraged(new Recall(new ValueMatches()), { whenEmpty: 1 }),
  valid,
  soft,
).score(comparison); // Ratio { part: 0.308641975308642, whole: 1 } for recall 1 and key F1 0.5
```

Put `Penalized` outside `SampleAveraged`. Then the factor multiplies the value of the record, and a record whose ratio has the whole 0 gets `whenEmpty` × the factor.

What a factor f does to each average:

- Samples average: a record gives Ratio(v × f, 1), so `Totals` gives the mean of v × f.
- Micro average: a record gives Ratio(hits × f, expected), so each hit counts with the factor of its record, and each expected value stays in the denominator.
- An F1 with `PrecisionRecallForm`: a factor between 0 and 1 gives a plain `Ratio`, whose value is part / whole.

## Micro average and samples average

A runner adds the ratios of many records with `Totals`: the sum of the parts divided by the sum of the wholes. So the scorer that you give decides the average:

- A plain scorer gives its counts, such as Ratio(2, 3). `Totals` then gives the micro average: all hits divided by all expected values.
- `new SampleAveraged(scorer, { whenEmpty })` gives the value of the scorer over 1, such as Ratio(0.67, 1). `Totals` then gives the samples average: the mean of the values of the records (scikit-learn `average='samples'`). `whenEmpty` is the value of a record whose ratio has the whole 0 (Decorator).

`new MeanOf(scorer, ...scorers)` gives the mean of the values of some scorers for one record.

Do not compare a micro average with a samples average.

## The schema

A case can have a JSON Schema, as a `JsonSchema`. `new JsonSchema(JsonValue.from(schema))` reads a JavaScript value. The `$schema` keyword of the schema names its draft: the package reads draft 7 and draft 2020-12, and another `$schema` throws. Without `$schema`, the package reads the schema as draft 2020-12. `new JsonSchema(value, { draft: '7' })` reads the schema as draft 7, whatever its `$schema` says. A `format` is an annotation: it does not fail a record.

The validator is cfworker's. The validator and `SchemaTypeWalk` read the schema with the same draft, so one schema has one meaning: under 2020-12, the walk reads `prefixItems`, and `items` is the schema of the items after them. They also read each `$ref` through one lookup, so they always read the same schema.

## Score a record with a scorer set

A `ScorerSet` of the core holds labelled scorers and gives a `Scorecard`. Its comparer compares the stated value with the case once, and each scorer reads that comparison. In this subpath, the comparer is `new TreeWalk(spec)`. The comparer is required: the core has no default comparer, because it cannot know a family.

```ts
import { F1, Penalized, Precision, Recall, ScorerSet } from '@zukhruf/evals';
import {
  AllMatched,
  PerField,
  SchemaCompliance,
  TreeWalk,
  ValueMatches,
} from '@zukhruf/evals/structured';

const valid = new SchemaCompliance();
const values = new ValueMatches({ nullIsMissing: true });

export const offerScorer = new ScorerSet(
  {
    valid,
    perfect: new AllMatched({ nullIsMissing: true }),
    precision: new Penalized(new Precision(values), valid),
    recall: new Penalized(new Recall(values), valid),
    f1: new Penalized(new F1(values), valid),
    recall_by_field: new PerField(new Penalized(new Recall(values), valid)),
  },
  { comparer: new TreeWalk(offerSpec) },
);

const scorecard = offerScorer.score(stated, testCase);
scorecard.passed; // true when each gate holds
scorecard.reason; // the explanations of the gates that fail
scorecard.ratios.get('recall'); // Ratio { part: 2, whole: 3 }
scorecard.ratios.get('$.offers[*].kind recall_by_field'); // Ratio { part: 2, whole: 2 }
```

`new PerField(scorer)` extends `Grouped` of the core. It gives one ratio for each field, under the label `${field} ${label}`. A field gets no ratio when the scorer counts nothing in it, that is, when the whole of its ratio is 0. So a scorer of leaves gives no ratio for an array such as `$.offers`, and a field of null leaves under `nullIsMissing` gets no ratio. `ItemMatches` gives a ratio for each array. A ratio with the whole 0 adds nothing to a ratio of sums, so the totals do not change. A gate in a `PerField` still reads the whole record. The score of the scorecard is the mean of the values of its scorers, without the ratios of a `PerField`. The checks of the scorecard are its gates.

```ts
import { Totals } from '@zukhruf/evals';

const totals = new Totals();
for (const row of rows) {
  const testCase = cases.from(row);
  totals.add(
    offerScorer.score(await harness(row.input), testCase),
    testCase.weight,
  );
}
totals.get('recall').value; // the micro recall of the run
```

## Cases

A `Case` holds the expected value, its JSON Schema when the scorers need one, and its weight. A case reader reads a case from the plain object that a runner holds for one test (Strategy):

- `new ConfigCase({ schema? })` reads `config.expected` as a JavaScript value. `schema` is one `JsonSchema` that serves every case. A case weighs 1.
- `new TextVarsCase({ schema? })` reads `vars.expected` as JSON text and `vars.schema` as a JSON value. JSON text keeps `7.0` a float, as `json.loads` reads it. `schema` is the function that builds the `JsonSchema` of each case from that value. The default is `(value) => new JsonSchema(value)`. A row without a weight weighs 1.

A case without a schema serves only the scorers that do not read a schema. `SchemaCompliance`, `ValidSchema`, `TypePrecision` and `RequiredKeyRecall` throw for it.

promptfoo parses each row, so an integral float such as `7.0` is already `7` in a JSON value. JSON text keeps `7.0` a float. promptfoo resolves a `$ref` in the vars of a row to its JSON value when the config gives the file of rows in a list (`tests: [file://tests.jsonl]`):

```json
{
  "vars": { "expected": "{\"a\": 7.0}", "schema": { "$ref": "./schema.json" } }
}
```

## Use it with promptfoo

`PromptfooAssertion` adapts a scorer set to a per-row assertion. It reads the case from the config of the assertion:

```ts
// promptfoo/assertions/offers.ts
import { z } from 'zod';

import { PromptfooAssertion } from '@zukhruf/evals/promptfoo';
import { ConfigCase, JsonSchema, JsonValue } from '@zukhruf/evals/structured';

import { offerScorer } from './offer-scorer.ts';

export default new PromptfooAssertion(
  offerScorer,
  new ConfigCase({
    schema: new JsonSchema(JsonValue.from(z.toJSONSchema(offersSchema))),
  }),
).grade;
```

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

The assertion passes when the scorecard passes. Each ratio becomes a named score, with its whole as the weight. promptfoo adds the value × the weight, so the column header shows the same ratio of sums as `Totals`.

`ScorerAssertion` of `@zukhruf/evals/promptfoo` adapts one scorer. It reads the case from the vars of the test, because an assertion that `defaultTest` shares gets only the vars of each test. `weight` sets how much its value counts in the score of the test, and `threshold` sets when it passes. `comparer` compares the answer with the case, and `cases` reads the case. All four are required:

```ts
// truth, spec and cases: see SOB as a configuration
new ScorerAssertion(truth, {
  weight: 1,
  threshold: 0,
  comparer: new TreeWalk(spec),
  cases,
});
```

The assertion gives the value of the ratio. promptfoo shows the mean of each metric over the tests, so give it a `SampleAveraged` scorer.

### Assertion modules

promptfoo stores the config of an eval as JSON, and `--resume` and `--retry-errors` build the run from the stored config. A function does not survive JSON. So a config does not hold a scorer assertion. It holds a file reference to the function of the scorer assertion (ADR 0013).

`AssertionModule` holds the scorer assertions of one module under their names. Give it the URL of the module, and give its `functions` as the default export of the module:

```ts
// evals/scorers.ts
import { AssertionModule, ScorerAssertion } from '@zukhruf/evals/promptfoo';
import {
  ExactMatch,
  SchemaCompliance,
  TextVarsCase,
  TreeWalk,
} from '@zukhruf/evals/structured';

const structured = { comparer: new TreeWalk(), cases: new TextVarsCase() };

export const scorers = new AssertionModule(import.meta.url, {
  valid_json: new ScorerAssertion(new SchemaCompliance(), {
    weight: 1,
    threshold: 1,
    ...structured,
  }),
  exact_match: new ScorerAssertion(new ExactMatch(), {
    weight: 1,
    threshold: 0,
    ...structured,
  }),
});

// promptfoo loads file://scorers.ts:<name> from this default export.
export default scorers.functions;
```

`assert(...names)` gives a promptfoo assertion for each name. Each one holds only JSON:

```ts
// evals/promptfooconfig.ts
import type { UnifiedConfig } from 'promptfoo';

import { scorers } from './scorers.ts';

export default {
  prompts: ['file://prompt.txt'],
  providers: ['openai:chat:gpt-6.1-sol'],
  defaultTest: { assert: scorers.assert('valid_json', 'exact_match') },
  tests: ['file://tests.jsonl'],
} satisfies UnifiedConfig;
```

`scorers.assert('valid_json')` gives:

```json
[
  {
    "type": "javascript",
    "metric": "valid_json",
    "weight": 1,
    "threshold": 1,
    "value": "file:///…/evals/scorers.ts:valid_json"
  }
]
```

The name is the metric. A name that the module does not have is a compile error. Keep the test generator in another module: promptfoo reads `file://…:load` on the default export too.

## SOB as a configuration

The Structured Output Benchmark (SOB, evaluate.py at commit da785a8) is a configuration of the core. Its caller composes it:

```ts
import {
  AtLeast,
  F1,
  Penalized,
  PrecisionRecallForm,
  Recall,
  SampleAveraged,
  type Scorer,
} from '@zukhruf/evals';
import {
  type Comparison,
  ComparisonSpec,
  JsonSchema,
  ParseSuccess,
  PathMatches,
  PythonEquality,
  RequiredKeyRecall,
  SchemaCompliance,
  TextVarsCase,
  TokenF1,
  TypePrecision,
  ValidSchema,
  ValueMatches,
} from '@zukhruf/evals/structured';

const spec = new ComparisonSpec({ comparator: new PythonEquality() }); // each array by position
// jsonschema's Draft7Validator: draft 7 for the validation and the type walk
const cases = new TextVarsCase({
  schema: (value) => new JsonSchema(value, { draft: '7' }),
});
const mean = (scorer: Scorer<Comparison>, whenEmpty: number) =>
  new SampleAveraged(scorer, { whenEmpty });

const form = new PrecisionRecallForm(); // each F1 is 2·p·r/(p + r)
const compliance = new SchemaCompliance();
const coverage = new AtLeast(
  mean(new F1(new PathMatches(), { form }), 0),
  0.95,
);

const truth = new Penalized(
  mean(new Recall(new ValueMatches()), 1),
  compliance,
  coverage,
);
const faithfulness = new Penalized(
  mean(new TokenF1({ whenNoWords: 1, absentAs: null, form }), 1),
  compliance,
  coverage,
);
const pathRecall = new Penalized(
  mean(new Recall(new PathMatches()), 0),
  compliance,
);
const structure = new Penalized(
  mean(new F1(new PathMatches(), { form }), 0),
  compliance,
);
const types = new Penalized(mean(new TypePrecision(), 0), compliance);
const required = new Penalized(
  mean(new RequiredKeyRecall(), 1),
  new ParseSuccess(),
  new ValidSchema(),
);
```

SOB pairs each array by position, compares values with Python's `==`, gives each F1 in the precision-recall form, reads null as a value, and takes the mean over the records. SOB's caller keeps its labels, its categories (`MeanOf`), its weights, its seeds and its interval method. The golden test composes SOB's report so and proves that it gives the numbers of evaluate.py, record by record.

### The subsets of SOB

SOB has three subsets, its modalities: text, image and audio. The coverage factor of evaluate.py depends on the subset (`compute_coverage_gate`, evaluate.py:615-618). It multiplies `leaf_value_em` and `value_token_f1` only (:305-306). The package has no class for a subset: the caller gives each test the scorers of its subset.

```ts
import {
  AtLeast,
  F1,
  Penalized,
  type Penalty,
  PrecisionRecallForm,
  Recall,
  SampleAveraged,
  type Scorer,
  ShortfallPenalty,
} from '@zukhruf/evals';
import {
  AssertionModule,
  type FileAssertion,
  ScorerAssertion,
} from '@zukhruf/evals/promptfoo';
import {
  type Comparison,
  PathMatches,
  SchemaCompliance,
  TokenF1,
  TreeWalk,
  ValueMatches,
} from '@zukhruf/evals/structured';

type Modality = 'text' | 'image' | 'audio';

const mean = (scorer: Scorer<Comparison>, whenEmpty: number) =>
  new SampleAveraged(scorer, { whenEmpty });
const form = new PrecisionRecallForm();
const compliance = new SchemaCompliance();
const keys = mean(new F1(new PathMatches(), { form }), 0); // raw_path_set_f1

// compute_coverage_gate: text 1 or 0 at 0.95; image and audio min(1, (keys / 0.90) ** 2)
const soft = new ShortfallPenalty(keys, { target: 0.9, power: 2 });
const coverage = {
  text: new AtLeast(keys, 0.95),
  image: soft,
  audio: soft,
} satisfies Record<Modality, Penalty<Comparison>>;

const scored = (modality: Modality) => ({
  truth: new Penalized(
    mean(new Recall(new ValueMatches()), 1),
    compliance,
    coverage[modality],
  ),
  faithfulness: new Penalized(
    mean(new TokenF1({ whenNoWords: 1, absentAs: null, form }), 1),
    compliance,
    coverage[modality],
  ),
});
```

Each subset has its own scorers, so each subset has its own names. The scorers of all subsets report under one metric: give the scorer assertion its `metric`.

```ts
// evals/scorers.ts. spec, cases and scored: as above.
const covered = (modality: Modality) => {
  const { truth, faithfulness } = scored(modality);
  const rule = {
    weight: 1,
    threshold: 0,
    comparer: new TreeWalk(spec),
    cases,
  };
  return {
    truth: new ScorerAssertion(truth, { ...rule, metric: 'field_recall' }),
    faithfulness: new ScorerAssertion(faithfulness, {
      ...rule,
      metric: 'token_f1',
    }),
  };
};
const text = covered('text');
const image = covered('image');
const audio = covered('audio');

export const scorers = new AssertionModule(import.meta.url, {
  // The other eight scorer assertions are the same in each subset.
  field_recall_text: text.truth,
  token_f1_text: text.faithfulness,
  field_recall_image: image.truth,
  token_f1_image: image.faithfulness,
  field_recall_audio: audio.truth,
  token_f1_audio: audio.faithfulness,
});
export default scorers.functions;

export const sobAssertions = {
  text: scorers.assert('field_recall_text', 'token_f1_text'),
  image: scorers.assert('field_recall_image', 'token_f1_image'),
  audio: scorers.assert('field_recall_audio', 'token_f1_audio'),
} satisfies Record<Modality, FileAssertion[]>;
```

Each test gets the assertions of its subset in its own `assert` list. promptfoo adds them after the `assert` of `defaultTest`:

```ts
{ vars, metadata: { modality }, assert: sobAssertions[modality] }
```

`satisfies Record<Modality, …>` makes TypeScript find a subset with no scorers, and `assert` makes it find a name that the module does not have. Without a runner, the caller picks the `ScorerSet` of the subset in the same way. The golden test checks the text subset, and an image run of the same lines checks `ShortfallPenalty`, record by record and in the summary (ADR 0012).

## Means and intervals

`Totals` gives the ratio of sums of each name over many scorecards, without weights (each weight 1) or with them. `Bootstrap` gives its percentile interval with `@zukhruf/statistics`: each resample draws as many scorecards as there are, with replacement, from the random generator that you give it. You also give the number of resamples and the method of the interval: a `PercentileInterval`, or a `ConfidenceIntervalMethod` of your own, such as SOB's in the golden test (ADR 0010).

```ts
import { Random } from 'python-random';

import { Linear, PercentileInterval } from '@zukhruf/statistics';

const rows = scorecards.map((scorecard, index) => ({
  scorecard,
  weight: weights[index],
}));
const random = new Random(42);
const bootstrap = new Bootstrap({
  nResamples: 1000,
  randomIndex: (n) => random.randrange(n),
  interval: new PercentileInterval({
    low: 0.025,
    high: 0.975,
    method: new Linear(),
  }),
});
bootstrap.interval(rows, 'truth'); // { low, high }
```

## Documentation

- [ADR 0001: the package is private and is reached through a workspace path](adr/structured/0001-the-package-is-private-and-is-reached-through-a-workspace-path.md)
- [ADR 0002: set items pair by maximum matching, and the metrics are micro averages](adr/structured/0002-set-items-pair-by-maximum-matching-and-the-metrics-are-micro-averages.md)
- [ADR 0003: SOB parity is a separate, lossless port of evaluate.py](adr/structured/0003-sob-parity-is-a-separate-lossless-port-of-evaluate-py.md)
- [ADR 0004: scorers give ratios, a ratio of sums adds them, and runners are adapters](adr/structured/0004-scorers-give-ratios-and-runners-are-adapters.md)
- [ADR 0005: metrics are classes named by what they measure, and a benchmark is a composition kept by its caller](adr/structured/0005-metrics-are-classes-named-by-what-they-measure.md)
- [ADR 0006: with promptfoo, each metric is one assertion that reads the vars of its test](adr/structured/0006-with-promptfoo-each-metric-is-one-assertion-that-reads-the-vars-of-its-test.md)
- [ADR 0007: a metric assertion is a promptfoo assertion object in a TypeScript config](adr/structured/0007-a-metric-assertion-is-a-promptfoo-assertion-object-in-a-typescript-config.md)
- [ADR 0008: type precision follows JSON Schema draft 7 and has no gate](adr/structured/0008-type-precision-follows-draft-7-and-has-no-gate.md)
- [ADR 0009: a scorer gives a value for one answer, and a metric adds the values of many answers](adr/structured/0009-a-scorer-gives-a-value-for-one-answer-and-a-metric-adds-many.md)
- [ADR 0010: the caller gives the bootstrap its interval, and @zukhruf/statistics draws it](adr/structured/0010-the-caller-gives-the-bootstrap-its-interval.md)
- [ADR 0011: one comparison core: the alignment of each array is a Strategy, and SOB is a configuration in its caller](adr/structured/0011-one-comparison-core-alignment-per-array-and-sob-is-a-configuration.md)
- [ADR 0012: a penalty multiplies the part of a ratio, and the caller scores each subset with its own scorers](adr/structured/0012-a-penalty-multiplies-the-part-of-a-ratio-and-the-caller-scores-each-subset-with-its-own-scorers.md)
- [ADR 0013: a scorer assertion reaches promptfoo as a file reference to a function of its assertion module](adr/structured/0013-a-scorer-assertion-reaches-promptfoo-as-a-file-reference-to-a-function-of-its-assertion-module.md)

## Development

`npx nx run evals:typecheck` and `npx nx run evals:build`.
