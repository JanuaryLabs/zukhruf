import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { multilabelSubsampling } from '../abstasks/abstask.ts';
import { iterativeTrainTestSplit } from '../abstasks/stratification.ts';
import { hammingScore } from '../evaluators/classification-metrics.ts';
import { pythonIntSetOrder } from './python-set.ts';
import { KNeighborsClassifier } from './sklearn-neighbors.ts';
import {
  type ClassLabel,
  MultiLabelBinarizer,
  accuracyScore,
  f1Score,
  labelRankingAveragePrecisionScore,
} from './sklearn.ts';

// fixtures/multilabel/expected.json holds what CPython 3.12.9, scikit-learn
// 1.9.1 and MTEB 2.26.28 gave for the parts of MTEB's multilabel
// classification: the order of a set of ints, MultiLabelBinarizer, the
// metrics of label indicator matrices, the iterative stratification, and
// KNeighborsClassifier. generate.py makes it.
type Expected = {
  readonly set_order: readonly {
    readonly case: string;
    readonly values: number[];
    readonly order: number[];
  }[];
  readonly set_order_large: {
    readonly count: number;
    readonly step: number;
    readonly sha256: string;
  };
  readonly binarizer: readonly {
    readonly case: string;
    readonly fit: ClassLabel[][];
    readonly other: ClassLabel[][];
    readonly classes: ClassLabel[];
    readonly fit_transform: number[][];
    readonly transform: number[][];
  }[];
  readonly metrics: readonly {
    readonly case: string;
    readonly y_true: number[][];
    readonly y_pred: number[][];
    readonly accuracy: number;
    readonly f1: number;
    readonly lrap: number;
    readonly hamming: number;
  }[];
  readonly lrap: readonly {
    readonly case: string;
    readonly y_true: number[][];
    readonly y_score: number[][];
    readonly lrap: number;
  }[];
  readonly stratification: readonly {
    readonly case: string;
    readonly label_sets: number[][];
    readonly n_samples: number;
    readonly seed: number;
    readonly train: number[];
    readonly test: number[];
    readonly subsampled_texts: string[];
  }[];
  readonly knn: readonly {
    readonly case: string;
    readonly n_neighbors: number;
    readonly x_train: number[][];
    readonly y_train: number[][];
    readonly x_test: number[][];
    readonly y_test: number[][];
    readonly distances: number[][];
    readonly indices: number[][];
    readonly predict: number[][];
    readonly score: number;
  }[];
};

const expected: Expected = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/multilabel/expected.json'),
    'utf8',
  ),
);

for (const { case: name, values, order } of expected.set_order)
  test(`a set of ints iterates in CPython's order: ${name}`, () => {
    assert.deepEqual(pythonIntSetOrder(values), order);
  });

// generate.py hashes the JSON text of the order without spaces, which is
// JSON.stringify of the order.
test(`a set of ints that fills the table to 3/5 grows, in CPython's order: ${expected.set_order_large.count} values`, () => {
  const { count, step, sha256 } = expected.set_order_large;

  const order = pythonIntSetOrder(
    Array.from({ length: count }, (_, index) => index * step),
  );

  assert.equal(
    createHash('sha256').update(JSON.stringify(order)).digest('hex'),
    sha256,
  );
});

for (const testCase of expected.binarizer)
  test(`MultiLabelBinarizer gives scikit-learn's classes and matrices: ${testCase.case}`, () => {
    const binarizer = new MultiLabelBinarizer();

    const fitted = binarizer.fitTransform(testCase.fit);
    const transformed = binarizer.transform(testCase.other);

    assert.deepEqual(
      { classes: binarizer.classes, fitted, transformed },
      {
        classes: testCase.classes,
        fitted: testCase.fit_transform,
        transformed: testCase.transform,
      },
    );
  });

for (const testCase of expected.metrics)
  test(`accuracy, macro F1, LRAP and MTEB's hamming score of label indicator matrices equal Python's to the last bit: ${testCase.case}`, () => {
    const { y_true: yTrue, y_pred: yPred } = testCase;

    const scores = {
      accuracy: accuracyScore(yTrue, yPred),
      f1: f1Score(yTrue, yPred, 'macro'),
      lrap: labelRankingAveragePrecisionScore(yTrue, yPred),
      hamming: hammingScore(yTrue, yPred),
    };

    assert.deepEqual(scores, {
      accuracy: testCase.accuracy,
      f1: testCase.f1,
      lrap: testCase.lrap,
      hamming: testCase.hamming,
    });
  });

for (const testCase of expected.lrap)
  test(`label_ranking_average_precision_score of scores equals scikit-learn's to the last bit: ${testCase.case}`, () => {
    assert.equal(
      labelRankingAveragePrecisionScore(testCase.y_true, testCase.y_score),
      testCase.lrap,
    );
  });

for (const testCase of expected.stratification)
  test(`the iterative stratification and the multilabel subsampling keep MTEB's rows: ${testCase.case}`, () => {
    const labels = new MultiLabelBinarizer().fitTransform(testCase.label_sets);
    const dataset = {
      columnNames: ['text', 'label'],
      rows: testCase.label_sets.map((label, index) => ({
        text: `row ${index}`,
        label,
      })),
    };

    const split = iterativeTrainTestSplit(
      labels,
      testCase.n_samples / testCase.label_sets.length,
      testCase.seed,
    );
    const subsampled = multilabelSubsampling(
      new Map([['test', dataset]]),
      testCase.seed,
      ['test'],
      'label',
      testCase.n_samples,
    ).get('test');

    assert.deepEqual(
      {
        ...split,
        texts: subsampled?.rows.map((row) => row.text),
      },
      {
        train: testCase.train,
        test: testCase.test,
        texts: testCase.subsampled_texts,
      },
    );
  });

// BLAS (dgemm and ddot) adds the dot products of the distances in its own
// order and the port in index order, but scikit-learn rounds each distance
// to a float32: on these cases all 410 distances are equal to the last bit.
for (const testCase of expected.knn)
  test(`KNeighborsClassifier finds scikit-learn's neighbours and predictions, to the last bit: ${testCase.case}`, () => {
    const xTrain = testCase.x_train.map((row) => Float32Array.from(row));
    const xTest = testCase.x_test.map((row) => Float32Array.from(row));

    const model = new KNeighborsClassifier({
      nNeighbors: testCase.n_neighbors,
    }).fit(xTrain, testCase.y_train);
    const { distances, indices } = model.kneighbors(xTest);

    assert.deepEqual(
      {
        distances,
        indices,
        predict: model.predict(xTest),
        score: model.score(xTest, testCase.y_test),
      },
      {
        distances: testCase.distances,
        indices: testCase.indices,
        predict: testCase.predict,
        score: testCase.score,
      },
    );
  });
