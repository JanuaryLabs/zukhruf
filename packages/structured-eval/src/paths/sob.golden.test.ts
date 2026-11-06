import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { Random } from 'python-random';

import type { JsonData } from '@zukhruf/python';

import {
  AtLeast,
  Bootstrap,
  CanonicalEquality,
  Gated,
  JsonCase,
  JsonValue,
  LeafExactMatch,
  LeafTokenF1,
  LeafTypePrecision,
  MeanOf,
  MetricScorer,
  ParseSuccess,
  PathF1,
  PathRecall,
  RequiredKeyRecall,
  SchemaCompliance,
  Totals,
  ValidSchema,
  type WeightedScorecard,
} from '../index.ts';
import expectedJson from './fixtures/sob-evaluate/expected.json' with { type: 'json' };

// fixtures/sob-evaluate/expected.json holds what the Structured Output
// Benchmark's evaluate.py (commit da785a8, CPython 3.12.9, jsonschema 4.26.0)
// wrote for the lines of fixtures/sob-evaluate/responses.jsonl: its
// eval_records rows and the summary of build_summary. generate.py makes it.
// This test composes SOB's report from the package's metrics and checks that
// the composition gives evaluate.py's numbers.
type Row = Readonly<Record<string, number | string>>;
type Interval = Readonly<Record<'mean' | 'ci95_low' | 'ci95_high', number>>;
type SummaryPart = {
  readonly n: number;
  readonly metrics: Readonly<Record<string, Interval>>;
  readonly category_scores: Readonly<Record<string, Interval>>;
};

const folder = join(import.meta.dirname, 'fixtures/sob-evaluate');
const expected: {
  readonly records: readonly Row[];
  readonly summary: {
    readonly overall: SummaryPart;
    readonly overall_weighted: SummaryPart;
  };
} = expectedJson;
const lines = readFileSync(join(folder, 'responses.jsonl'), 'utf8').split('\n');

// SOB's metrics, each labelled with its key in eval_records.
const parsed = new ParseSuccess();
const compliance = new SchemaCompliance();
const coverage = new AtLeast(new PathF1(), 0.95);
const truth = new Gated(new LeafExactMatch(), compliance, coverage);
const faithfulness = new Gated(new LeafTokenF1(), compliance, coverage);
const pathRecall = new Gated(new PathRecall(), compliance);
const structureCoverage = new Gated(new PathF1(), compliance);
const typeSafety = new Gated(new LeafTypePrecision(), compliance);
const perfect = new CanonicalEquality();
const metrics = {
  json_parse_success: parsed,
  json_root_structured: parsed,
  schema_valid_input: new ValidSchema(),
  schema_compliance: compliance,
  leaf_value_em: truth,
  value_token_f1: faithfulness,
  hier_path_recall: pathRecall,
  path_set_f1: structureCoverage,
  type_precision: typeSafety,
  required_key_recall: new Gated(
    new RequiredKeyRecall({ whenNoneRequired: 1 }),
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
// build_summary bootstraps these metrics, in this order, then the categories.
const summarized = [
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
  ...Object.keys(categories),
];
// DIFFICULTY_WEIGHTS of evaluate.py; an unknown complexity weighs 0.
const weights = new Map<JsonData | undefined, number>([
  ['easy', 1],
  ['medium', 2],
  ['hard', 3],
]);

const field = (data: JsonData | undefined, key: string) =>
  data instanceof Map ? data.get(key) : undefined;

// A SOB line, read as evaluate_file and evaluate_record read it: a blank line
// and a line that is not JSON are skipped.
function sobLines(): { stated: JsonValue; testCase: JsonCase }[] {
  const read: { stated: JsonValue; testCase: JsonCase }[] = [];
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
      testCase: new JsonCase(
        field(field(record, 'output'), 'ground_truth') ?? null,
        field(field(record, 'input'), 'json_schema') ?? null,
        weight ?? 0,
      ),
    });
  }
  return read;
}

test('each line gives the 11 values and the weight of its eval_records row', () => {
  const scorer = new MetricScorer(metrics);

  const rows = sobLines().map(({ stated, testCase }) => {
    const scorecard = scorer.score(stated, testCase);
    return {
      difficulty_weight: testCase.weight,
      ...Object.fromEntries(
        Object.keys(metrics).map((key) => [
          key,
          scorecard.ratios.get(key)?.value,
        ]),
      ),
    };
  });

  assert.deepEqual(
    rows,
    expected.records.map((row) => ({
      difficulty_weight: row['difficulty_weight'],
      ...Object.fromEntries(Object.keys(metrics).map((key) => [key, row[key]])),
    })),
  );
});

test('the means, the category means and the bootstrap intervals equal build_summary, without and with weights', () => {
  const scorer = new MetricScorer({ ...metrics, ...categories });
  const scored = sobLines().map(({ stated, testCase }) => ({
    scorecard: scorer.score(stated, testCase),
    weight: testCase.weight,
  }));

  // summarize_rows: one Random(seed) without weights, Random(seed + 1) with.
  const summary = (weighted: boolean, seed: number) => {
    const rows: WeightedScorecard[] = scored.map(({ scorecard, weight }) => ({
      scorecard,
      weight: weighted ? weight : 1,
    }));
    const totals = new Totals();
    for (const { scorecard, weight } of rows) totals.add(scorecard, weight);
    const bootstrap = new Bootstrap(new Random(seed), 1000);
    return Object.fromEntries(
      summarized.map((name) => {
        const [low, high] = bootstrap.interval(rows, name);
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

  assert.deepEqual(summary(false, 42), numbers(expected.summary.overall));
  assert.deepEqual(
    summary(true, 43),
    numbers(expected.summary.overall_weighted),
  );
  assert.equal(scored.length, expected.summary.overall.n);
});
