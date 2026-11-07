import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { Random } from 'python-random';

import type { JsonData } from '@zukhruf/python';
import {
  ConfidenceInterval,
  type ConfidenceIntervalMethod,
  Higher,
  Lower,
} from '@zukhruf/statistics';

import {
  AtLeast,
  Bootstrap,
  Case,
  ComparisonSpec,
  ExactMatch,
  F1,
  JsonSchema,
  JsonValue,
  MeanOf,
  ParseSuccess,
  PathMatches,
  Penalized,
  type Penalty,
  PythonEquality,
  Recall,
  RequiredKeyRecall,
  SampleAveraged,
  SchemaCompliance,
  type Scorer,
  ScorerSet,
  ShortfallPenalty,
  TokenF1,
  Totals,
  TypePrecision,
  ValidSchema,
  ValueMatches,
  type WeightedScorecard,
} from '../index.ts';
import expectedJson from './fixtures/sob-evaluate/expected.json' with { type: 'json' };

// fixtures/sob-evaluate/expected.json holds what the Structured Output
// Benchmark's evaluate.py (commit da785a8, CPython 3.12.9, jsonschema 4.26.0)
// wrote for the lines of fixtures/sob-evaluate/responses.jsonl: its
// eval_records rows and the summary of build_summary, for the modality text
// and, under "image", for the modality image. generate.py makes it.
// This test composes SOB's report from the package's scorers and checks that
// the composition gives evaluate.py's numbers.
type Row = Readonly<Record<string, number | string>>;
type Interval = Readonly<Record<'mean' | 'ci95_low' | 'ci95_high', number>>;
type SummaryPart = {
  readonly n: number;
  readonly metrics: Readonly<Record<string, Interval>>;
  readonly category_scores: Readonly<Record<string, Interval>>;
};

type Oracle = {
  readonly records: readonly Row[];
  readonly summary: {
    readonly overall: SummaryPart;
    readonly overall_weighted: SummaryPart;
  };
};

const folder = join(import.meta.dirname, 'fixtures/sob-evaluate');
const expected: Oracle & { readonly image: Oracle } = expectedJson;
const lines = readFileSync(join(folder, 'responses.jsonl'), 'utf8').split('\n');

// SOB's scorers, each labelled with its key in eval_records, as SOB's caller
// composes them (README, "SOB as a configuration"), with the coverage factor
// of the modality (README, "The subsets of SOB"): SOB takes the mean over
// the records, so each scorer is SampleAveraged, with SOB's value for a
// record whose ratio has the whole 0, and Penalized multiplies the value of
// the record. SOB pairs each array by position and compares values with
// Python's ==.
const spec = new ComparisonSpec({ comparator: new PythonEquality() });
const mean = (scorer: Scorer, whenEmpty: number) =>
  new SampleAveraged(scorer, { whenEmpty });
const parsed = new ParseSuccess();
const compliance = new SchemaCompliance();
const keyF1 = mean(new F1(new PathMatches()), 0);

function sob(coverage: Penalty) {
  const truth = new Penalized(
    mean(new Recall(new ValueMatches()), 1),
    compliance,
    coverage,
  );
  const faithfulness = new Penalized(
    mean(new TokenF1({ whenNoWords: 1, absentAs: null }), 1),
    compliance,
    coverage,
  );
  const pathRecall = new Penalized(
    mean(new Recall(new PathMatches()), 0),
    compliance,
  );
  const structureCoverage = new Penalized(keyF1, compliance);
  const typeSafety = new Penalized(mean(new TypePrecision(), 0), compliance);
  const perfect = new ExactMatch();
  const scorers = {
    json_parse_success: parsed,
    json_root_structured: parsed,
    schema_valid_input: new ValidSchema(),
    schema_compliance: compliance,
    leaf_value_em: truth,
    value_token_f1: faithfulness,
    hier_path_recall: pathRecall,
    path_set_f1: structureCoverage,
    type_precision: typeSafety,
    required_key_recall: new Penalized(
      mean(new RequiredKeyRecall(), 1),
      new ParseSuccess(),
      new ValidSchema(),
    ),
    strict_json_em: perfect,
  };
  // CATEGORIES of evaluate.py: the mean of their components for each record.
  const categories = {
    'Long Context Extraction': new MeanOf(truth, faithfulness, pathRecall),
    'Complex Schema Handling': new MeanOf(
      compliance,
      structureCoverage,
      typeSafety,
    ),
    'Multi-Context Linking': new MeanOf(truth, faithfulness),
    'Output Contract Reliability': new MeanOf(parsed, compliance, typeSafety),
    'Strict Precision': new MeanOf(perfect),
  };
  return { scorers, categories };
}

// compute_coverage_gate of evaluate.py: a gate at 0.95 for text, the factor
// min(1, (key F1 / 0.90) ** 2) for image and audio.
const modalities = [
  { modality: 'text', oracle: expected, ...sob(new AtLeast(keyF1, 0.95)) },
  {
    modality: 'image',
    oracle: expected.image,
    ...sob(new ShortfallPenalty(keyF1, { target: 0.9, power: 2 })),
  },
];
// build_summary bootstraps these metrics, in this order, then the categories.
const metrics = [
  'json_parse_success',
  'json_root_structured',
  'schema_valid_input',
  'schema_compliance',
  'leaf_value_em',
  'value_token_f1',
  'hier_path_recall',
  'path_set_f1',
  'type_precision',
  'strict_json_em',
];
// DIFFICULTY_WEIGHTS of evaluate.py; an unknown complexity weighs 0.
const weights = new Map<JsonData | undefined, number>([
  ['easy', 1],
  ['medium', 2],
  ['hard', 3],
]);

const field = (data: JsonData | undefined, key: string) =>
  data instanceof Map ? data.get(key) : undefined;

// Whether a stated value has a leaf: a dict or a list that holds, at any
// depth, a value that is not a dict or a list (flatten_leaf_paths).
const hasLeaf = (value: JsonData | undefined): boolean =>
  (value instanceof Map
    ? [...value.values()]
    : Array.isArray(value)
      ? value
      : []
  ).some((child) =>
    child instanceof Map || Array.isArray(child) ? hasLeaf(child) : true,
  );

// The numbers of the summary that average type_precision have no oracle:
// build_summary averaged the type_precision of evaluate.py's walk, which is
// not draft 7 (ADR 0008). Two categories average it with other metrics, so
// they are left out whole. The draws pick positions, not values, so the
// numbers that do not average type_precision keep their oracle.
const averagesTypePrecision = new Set([
  'type_precision',
  'Complex Schema Handling',
  'Output Contract Reliability',
]);
const withoutTypePrecision = (summary: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(summary).filter(
      ([name]) => !averagesTypePrecision.has(name),
    ),
  );

// A SOB line, read as evaluate_file and evaluate_record read it: a blank line
// and a line that is not JSON are skipped.
function sobLines(): { stated: JsonValue; testCase: Case }[] {
  const read: { stated: JsonValue; testCase: Case }[] = [];
  for (const text of lines) {
    if (text.trim() === '') continue;
    let record: JsonData;
    try {
      record = JsonValue.parse(text.trim()).value;
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
    const metadata = field(record, 'metadata');
    const weight = [
      field(metadata, 'schema_complexity'),
      field(metadata, 'difficulty'),
    ]
      .map((level) => weights.get(level))
      .find((known) => known !== undefined);
    read.push({
      stated: new JsonValue(
        field(field(record, 'output'), 'candidate_response') ?? null,
      ),
      // jsonschema's Draft7Validator reads every schema as draft 7.
      testCase: new Case({
        expected: field(field(record, 'output'), 'ground_truth') ?? null,
        schema: new JsonSchema(
          new JsonValue(field(field(record, 'input'), 'json_schema') ?? null),
          { draft: '7' },
        ),
        weight: weight ?? 0,
      }),
    });
  }
  return read;
}

for (const { modality, oracle, scorers, categories } of modalities) {
  test(`${modality}: each line gives the 11 values and the weight of its eval_records row`, () => {
    const scorer = new ScorerSet(scorers, { spec });
    const lines = sobLines();

    const rows = lines.map(({ stated, testCase }) => {
      const scorecard = scorer.score(stated, testCase);
      return {
        difficulty_weight: testCase.weight,
        ...Object.fromEntries(
          Object.keys(scorers).map((key) => [
            key,
            scorecard.ratios.get(key)?.value,
          ]),
        ),
      };
    });

    assert.deepEqual(
      rows,
      oracle.records.map((row, index) => ({
        difficulty_weight: row['difficulty_weight'],
        ...Object.fromEntries(
          Object.keys(scorers).map((key) => [key, row[key]]),
        ),
        // evaluate.py's walk is not draft 7, so its type_precision is not the
        // oracle (ADR 0008). By draft 7 a record that agrees with its schema
        // has no leaf of a type that the schema refuses, so SOB's gated
        // type_precision is evaluate.py's own schema_compliance, or 0
        // (SOB's whenEmpty) for a stated value with no leaf. This proves one
        // direction only: the walk refuses no type of a valid record. The gate
        // hides what it gives an invalid one; type-precision.test.ts
        // proves that.
        type_precision:
          row['schema_compliance'] === 1 && hasLeaf(lines[index]?.stated.value)
            ? 1
            : 0,
      })),
    );
  });

  test(`${modality}: the means, the category means and the bootstrap intervals equal build_summary, without and with weights`, () => {
    const scorer = new ScorerSet({ ...scorers, ...categories }, { spec });
    const scored = sobLines().map(({ stated, testCase }) => ({
      scorecard: scorer.score(stated, testCase),
      weight: testCase.weight,
    }));

    // percentile_bounds of SOB's evaluate.py: the estimates at
    // floor(0.025(n - 1)) and ceil(0.975(n - 1)) of the sorted estimates, which
    // are NumPy's lower method at the low end and its higher method at the high
    // end. A percentile interval reads both ends with one method, so SOB's
    // interval is SOB's own method.
    const percentileBounds: ConfidenceIntervalMethod = {
      of: (distribution) => {
        const sorted = distribution.toSorted((a, b) => a - b);
        return new ConfidenceInterval(
          new Lower().of(sorted, 0.025),
          new Higher().of(sorted, 0.975),
        );
      },
    };
    // summarize_rows: one Random(seed) without weights, Random(seed + 1) with.
    const summary = (weighted: boolean, seed: number) => {
      const rows: WeightedScorecard[] = scored.map(({ scorecard, weight }) => ({
        scorecard,
        weight: weighted ? weight : 1,
      }));
      const totals = new Totals();
      for (const { scorecard, weight } of rows) totals.add(scorecard, weight);
      const random = new Random(seed);
      const bootstrap = new Bootstrap({
        nResamples: 1000,
        randomIndex: (n) => random.randrange(n),
        interval: percentileBounds,
      });
      return Object.fromEntries(
        [...metrics, ...Object.keys(categories)].map((name) => {
          const { low, high } = bootstrap.interval(rows, name);
          return [
            name,
            { mean: totals.get(name).value, ci95_low: low, ci95_high: high },
          ];
        }),
      );
    };
    const numbers = ({ metrics: means, category_scores }: SummaryPart) =>
      Object.fromEntries(
        Object.entries({ ...means, ...category_scores }).map(
          ([name, { mean, ci95_low, ci95_high }]) => [
            name,
            { mean, ci95_low, ci95_high },
          ],
        ),
      );

    assert.deepEqual(
      withoutTypePrecision(summary(false, 42)),
      withoutTypePrecision(numbers(oracle.summary.overall)),
    );
    assert.deepEqual(
      withoutTypePrecision(summary(true, 43)),
      withoutTypePrecision(numbers(oracle.summary.overall_weighted)),
    );
    assert.equal(scored.length, oracle.summary.overall.n);
  });
}
