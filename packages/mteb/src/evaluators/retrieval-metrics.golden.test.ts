import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { RelevanceEvaluator } from '../dependencies/pytrec-eval.ts';
import {
  calculateRetrievalScores,
  confidenceScores,
  makeScoreDict,
  nauc,
} from './retrieval-metrics.ts';

// Golden cases: random qrels and runs (graded, negative and unjudged
// relevance, ties, scores that collide as float32, unsorted cutoffs) that
// MTEB 2.26.28 with pytrec_eval 0.5.11, numpy 2.5.4 and CPython 3.12 scored.
// A Python dict is a list of [key, value] pairs, so its order survives, and a
// float that JSON cannot hold is a string.
type Pairs<Value> = [string, Value][];
type Fixture = {
  readonly cases: readonly {
    readonly qrels: Pairs<Pairs<number>>;
    readonly run: Pairs<Pairs<number>>;
    readonly k: readonly number[];
    readonly all_scores: Pairs<Pairs<number | string>>;
    readonly score_dict: Pairs<number | string>;
    readonly defaults: Pairs<Pairs<number>>;
  }[];
  readonly nauc: readonly {
    readonly confidence: readonly number[];
    readonly metrics: readonly number[];
    readonly nauc: number | string;
    readonly conf_scores: Pairs<number>;
  }[];
};

const fixture: Fixture = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/retrieval-metrics.json'),
    'utf8',
  ),
);

function nested(pairs: Pairs<Pairs<number>>): Map<string, Map<string, number>> {
  return new Map(pairs.map(([key, inner]) => [key, new Map(inner)]));
}

function number(value: number | string): number {
  return typeof value === 'number' ? value : Number(value);
}

function sameEntries(
  actual: Readonly<Record<string, unknown>>,
  expected: Pairs<number | string | null | readonly unknown[]>,
): void {
  assert.deepEqual(
    Object.keys(actual),
    expected.map(([key]) => key),
  );
  for (const [key, value] of expected)
    assert.deepEqual(
      actual[key],
      typeof value === 'string' ? number(value) : value,
      key,
    );
}

test('pytrec_eval measures equal those of pytrec_eval on every golden case', () => {
  for (const [index, golden] of fixture.cases.entries()) {
    const evaluator = new RelevanceEvaluator(nested(golden.qrels), [
      'recip_rank',
      'P.5,1',
      'ndcg_cut',
      'success',
    ]);

    const evaluation = evaluator.evaluate(nested(golden.run));

    assert.deepEqual(
      [...evaluation.keys()],
      golden.defaults.map(([query]) => query),
      `case ${index}`,
    );
    for (const [query, measures] of golden.defaults)
      sameEntries(evaluation.get(query) ?? {}, measures);
  }
});

test('the retrieval scores equal those of MTEB on every golden case', () => {
  for (const [index, golden] of fixture.cases.entries()) {
    const evaluation = calculateRetrievalScores(
      nested(golden.run),
      nested(golden.qrels),
      golden.k,
    );

    const scores = makeScoreDict({ ...evaluation, taskScores: {} });

    assert.deepEqual(
      [...evaluation.allScores.keys()],
      golden.all_scores.map(([query]) => query),
      `case ${index}`,
    );
    for (const [query, measures] of golden.all_scores)
      sameEntries(evaluation.allScores.get(query) ?? {}, measures);
    sameEntries(scores, golden.score_dict);
  }
});

test('nAUC and the confidence scores equal those of MTEB', () => {
  for (const golden of fixture.nauc) {
    const value = nauc(golden.confidence, golden.metrics);
    const confidence = confidenceScores(golden.metrics);

    assert.equal(value, number(golden.nauc));
    sameEntries(confidence, golden.conf_scores);
  }
});
