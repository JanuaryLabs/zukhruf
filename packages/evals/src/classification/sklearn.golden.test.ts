import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  F1,
  Precision,
  Recall,
  type Scorer,
  ScorerSet,
  Totals,
} from '../index.ts';
import {
  AllClassMatches,
  ClassMatches,
  type Label,
  LabelCase,
  LabelComparer,
  type LabelComparison,
  LabelsMatch,
  PerClass,
} from './index.ts';

// fixtures/sklearn/expected.json holds what scikit-learn 1.9.1 (numpy 2.5.4,
// CPython 3.12.9) gave for each case: generate.py makes it. A float NaN is
// the string "NaN".
type Value = number | 'NaN';
type Scores = Readonly<Record<'precision' | 'recall' | 'f1', Value>>;
type Sklearn = {
  readonly case: string;
  readonly y_true: readonly (Label | readonly number[])[];
  readonly y_pred: readonly (Label | readonly number[])[];
  readonly sample_weight?: readonly number[] | null;
  readonly labels?: readonly Label[];
  readonly accuracy: number;
  readonly none: Readonly<
    Record<'precision' | 'recall' | 'f1', readonly Value[]> & {
      readonly support: readonly number[];
    }
  >;
  readonly micro: Scores;
  readonly macro: Scores;
  readonly weighted: Scores;
};
type Expected = {
  readonly multiclass: readonly Sklearn[];
  readonly multilabel: readonly Sklearn[];
};

const expected: Expected = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/sklearn/expected.json'),
    'utf8',
  ),
);

// The answers of a case: one LabelCase and one stated answer for each row. A
// row of a label indicator matrix is the set of the columns that hold 1.
const answers = (sklearn: Sklearn) =>
  sklearn.y_true.map((row, index) => {
    const labels = (y: Label | readonly number[]) =>
      typeof y === 'object'
        ? y.flatMap((value, column) => (value === 1 ? [column] : []))
        : y;
    return {
      testCase: new LabelCase({
        expected: labels(row),
        weight: sklearn.sample_weight?.[index] ?? 1,
      }),
      stated: labels(sklearn.y_pred[index] ?? []),
    };
  });

// The labels of a case: its sorted labels, or the columns of its rows.
const classes = (sklearn: Sklearn): readonly Label[] => {
  if (sklearn.labels !== undefined) return sklearn.labels;
  const row = sklearn.y_true[0];
  assert.ok(typeof row === 'object');
  return row.map((_, column) => column);
};

const totalsOf = (
  sklearn: Sklearn,
  scorers: Readonly<Record<string, Scorer<LabelComparison> | PerClass>>,
) => {
  const scorer = new ScorerSet(scorers, { comparer: new LabelComparer() });
  const totals = new Totals();
  for (const { testCase, stated } of answers(sklearn))
    totals.add(scorer.score(stated, testCase), testCase.weight);
  return totals;
};

// The cases whose weights are integers: Totals adds with CPython's sum, so a
// float weight can differ from numpy's order of addition in the last bit.
const integerWeights = [...expected.multiclass, ...expected.multilabel].filter(
  ({ sample_weight }) => (sample_weight ?? []).every(Number.isInteger),
);

test("ClassMatches pooled by Totals gives scikit-learn's precision, recall and F1 of each class (average=None), for a class and for a set of classes", () => {
  const differ: string[] = [];

  for (const sklearn of integerWeights) {
    const labels = classes(sklearn);
    const totals = totalsOf(
      sklearn,
      Object.fromEntries(
        labels.flatMap((label) => [
          [`${label} precision`, new Precision(new ClassMatches(label))],
          [`${label} recall`, new Recall(new ClassMatches(label))],
          [`${label} f1`, new F1(new ClassMatches(label))],
        ]),
      ),
    );
    for (const metric of ['precision', 'recall', 'f1'] as const)
      for (const [index, label] of labels.entries())
        if (
          !Object.is(
            totals.get(`${label} ${metric}`).value,
            sklearn.none[metric][index],
          )
        )
          differ.push(`${sklearn.case}: ${label} ${metric}`);
  }

  assert.deepEqual(differ, []);
});

test("AllClassMatches pooled by Totals gives scikit-learn's micro precision, recall and F1", () => {
  const differ: string[] = [];

  for (const sklearn of integerWeights) {
    const totals = totalsOf(sklearn, {
      precision: new Precision(new AllClassMatches()),
      recall: new Recall(new AllClassMatches()),
      f1: new F1(new AllClassMatches()),
    });
    for (const metric of ['precision', 'recall', 'f1'] as const)
      if (!Object.is(totals.get(metric).value, sklearn.micro[metric]))
        differ.push(`${sklearn.case}: ${metric}`);
  }

  assert.deepEqual(differ, []);
});

test("LabelsMatch pooled by Totals gives scikit-learn's accuracy_score, the subset accuracy for a set of classes", () => {
  const differ = integerWeights
    .filter(
      (sklearn) =>
        !Object.is(
          totalsOf(sklearn, { accuracy: new LabelsMatch() }).get('accuracy')
            .value,
          sklearn.accuracy,
        ),
    )
    .map((sklearn) => sklearn.case);

  assert.deepEqual(differ, []);
});

test("PerClass gives the ratio of each class under the label `${class} ${label}`, and Totals of them gives scikit-learn's recall of each class", () => {
  const sklearn = expected.multiclass.find(
    (sklearn) => sklearn.case === 'strings in code point order',
  );
  assert.ok(sklearn);

  const totals = totalsOf(sklearn, {
    recall: new PerClass(new Recall(new AllClassMatches())),
  });

  assert.deepEqual(
    (sklearn.labels ?? []).map((label) => totals.get(`${label} recall`).value),
    sklearn.none.recall,
  );
});
