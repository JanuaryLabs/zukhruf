import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  type ClassLabel,
  accuracyScore,
  f1Score,
  precisionScore,
  recallScore,
} from './sklearn.ts';

// fixtures/classification-metrics/expected.json holds what scikit-learn 1.9.1
// returned for pairs of true and predicted labels: accuracy_score, and
// f1_score, precision_score and recall_score with the macro and the
// weighted average. generate.py makes it.
type Case = {
  readonly case: string;
  readonly y_true: ClassLabel[];
  readonly y_pred: ClassLabel[];
  readonly scores: Readonly<Record<string, number>>;
};

const expected: { readonly cases: readonly Case[] } = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/classification-metrics/expected.json'),
    'utf8',
  ),
);

for (const metricCase of expected.cases)
  test(`the classification metrics of "${metricCase.case}" equal scikit-learn's to the last bit`, () => {
    const { y_true: yTrue, y_pred: yPred } = metricCase;

    const scores = {
      accuracy: accuracyScore(yTrue, yPred),
      f1_macro: f1Score(yTrue, yPred, 'macro'),
      precision_macro: precisionScore(yTrue, yPred, 'macro'),
      recall_macro: recallScore(yTrue, yPred, 'macro'),
      f1_weighted: f1Score(yTrue, yPred, 'weighted'),
      precision_weighted: precisionScore(yTrue, yPred, 'weighted'),
      recall_weighted: recallScore(yTrue, yPred, 'weighted'),
    };

    assert.deepEqual(scores, metricCase.scores);
  });

test('labels of different lengths throw, as scikit-learn raises a ValueError', () => {
  assert.throws(() => accuracyScore([0, 1], [0]), {
    message:
      'Found input variables with inconsistent numbers of samples: [2, 1]',
  });
});

test('empty labels throw, as scikit-learn raises a ValueError', () => {
  assert.throws(() => f1Score([], [], 'macro'), {
    message:
      'Found empty input array (e.g., `y_true` or `y_pred`) while a minimum of 1 sample is required.',
  });
});

test('string and number labels together throw, as unique_labels raises a ValueError', () => {
  assert.throws(() => precisionScore(['a', 1], ['a', 1], 'weighted'), {
    message: 'Mix of label input types (string and number)',
  });
});
