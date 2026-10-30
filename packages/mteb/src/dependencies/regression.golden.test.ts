import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { trainTestSplit } from './datasets-train-test-split.ts';
import { NumpyGenerator } from './numpy-random.ts';
import { qcut } from './pandas.ts';
import { kendalltau } from './scipy.ts';
import {
  FittedLinearRegression,
  LinearRegression,
} from './sklearn-linear-regression.ts';
import { meanAbsoluteError, meanSquaredError, r2Score } from './sklearn.ts';

// fixtures/regression/expected.json holds what SciPy 1.18.1, scikit-learn
// 1.9.1, pandas 3.1.0, datasets 5.1.0 and NumPy 2.5.4 gave for the parts of
// MTEB's regression tasks: kendalltau, the regression metrics, qcut, the
// stratified train_test_split and LinearRegression. null is NaN.
// generate.py makes it.
type Generated = readonly [seed: number, high: number, size: number];

type Expected = {
  readonly kendalltau: readonly {
    readonly case: string;
    readonly x: (number | null)[] | null;
    readonly y: (number | null)[] | null;
    readonly generated?: { readonly x: Generated; readonly y: Generated };
    readonly statistic: number | null;
  }[];
  readonly metrics: readonly {
    readonly case: string;
    readonly y_true: number[];
    readonly y_pred: number[];
    readonly mse: number;
    readonly mae: number;
    readonly r2: number | null;
    readonly rmse: number;
  }[];
  readonly qcut: readonly {
    readonly case: string;
    readonly x: number[];
    readonly ids: (number | null)[];
  }[];
  readonly train_test_split: readonly {
    readonly case: string;
    readonly labels: number[];
    readonly test_size: number;
    readonly seed: number;
    readonly train?: number[];
    readonly test?: number[];
    readonly error?: string;
  }[];
  readonly linear_regression: readonly {
    readonly case: string;
    readonly x?: number[][];
    readonly x_test?: number[][];
    readonly generated?: {
      readonly x: readonly [seed: number, rows: number, columns: number];
      readonly x_test: readonly [seed: number, rows: number, columns: number];
    };
    readonly y: number[];
    readonly coef: number[];
    readonly intercept: number;
    readonly rank: number;
    readonly singular: number[];
    readonly predictions: number[];
  }[];
};

const expected: Expected = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/regression/expected.json'),
    'utf8',
  ),
);

const nanOf = (values: readonly (number | null)[]) =>
  values.map((value) => value ?? Number.NaN);

// The "generated" values of generate.py, from numpy's integers.
function integers([seed, high, size]: Generated): number[] {
  return new NumpyGenerator(seed).integers(0, high, size);
}

function generatedRows([seed, rows, columns]: readonly [
  number,
  number,
  number,
]): Float32Array[] {
  const values = integers([seed, 1000, rows * columns]);
  return Array.from({ length: rows }, (_, row) =>
    Float32Array.from(
      values.slice(row * columns, (row + 1) * columns),
      (value) => (value - 500) / 100,
    ),
  );
}

test('kendalltau gives the tau-b of SciPy to the last bit, with NaN for fewer than 2 values, a NaN or a constant array', () => {
  const actual = expected.kendalltau.map((kase) => {
    const x = kase.generated ? integers(kase.generated.x) : nanOf(kase.x ?? []);
    const y = kase.generated
      ? Float32Array.from(
          integers(kase.generated.y),
          (value) => (value - 50_000) / 1000,
        )
      : Float32Array.from(nanOf(kase.y ?? []));
    return { case: kase.case, statistic: kendalltau(x, y) };
  });

  assert.deepEqual(
    actual,
    expected.kendalltau.map((kase) => ({
      case: kase.case,
      statistic: kase.statistic ?? Number.NaN,
    })),
  );
});

test('the regression metrics of float32 predictions equal the ones of scikit-learn to the last bit: mse, mae, r2 and the square root of mse', () => {
  const actual = expected.metrics.map((kase) => {
    const yPred = Float32Array.from(kase.y_pred);
    const mse = meanSquaredError(kase.y_true, yPred);
    return {
      case: kase.case,
      mse,
      mae: meanAbsoluteError(kase.y_true, yPred),
      r2: r2Score(kase.y_true, yPred),
      rmse: Math.sqrt(mse),
    };
  });

  assert.deepEqual(
    actual,
    expected.metrics.map((kase) => ({
      case: kase.case,
      mse: kase.mse,
      mae: kase.mae,
      r2: kase.r2 ?? Number.NaN,
      rmse: kase.rmse,
    })),
  );
});

test('qcut gives the bins of pandas, with equal edges dropped and NaN for a constant', () => {
  const actual = expected.qcut.map((kase) => ({
    case: kase.case,
    ids: qcut(kase.x, 10, { labels: false, duplicates: 'drop' }),
  }));

  assert.deepEqual(
    actual,
    expected.qcut.map((kase) => ({ case: kase.case, ids: nanOf(kase.ids) })),
  );
});

test('trainTestSplit gives the train and test rows of the stratified train_test_split of datasets, in their order, or its error', () => {
  const actual = expected.train_test_split.map((kase) => {
    const dataset = {
      columnNames: ['label', 'i'],
      rows: kase.labels.map((label, i) => ({ label, i })),
    };
    try {
      const split = trainTestSplit(dataset, {
        testSize: kase.test_size,
        seed: kase.seed,
        stratifyByColumn: 'label',
      });
      const rowsOf = (name: string) =>
        split.get(name)?.rows.map((row) => row['i']);
      return { case: kase.case, train: rowsOf('train'), test: rowsOf('test') };
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return { case: kase.case, error: error.message };
    }
  });

  assert.deepEqual(
    actual,
    expected.train_test_split.map(({ case: name, train, test, error }) =>
      error === undefined ? { case: name, train, test } : { case: name, error },
    ),
  );
});

// The rows and the test rows of a case.
function dataOf(kase: Expected['linear_regression'][number]) {
  if (kase.generated)
    return {
      x: generatedRows(kase.generated.x),
      xTest: generatedRows(kase.generated.x_test),
    };
  return {
    x: (kase.x ?? []).map((row) => Float32Array.from(row)),
    xTest: (kase.x_test ?? []).map((row) => Float32Array.from(row)),
  };
}

// The largest |actual - expected| / scale over the values.
function largestDifference(
  actual: ArrayLike<number>,
  expectedValues: readonly number[],
  scales: readonly number[],
): number {
  assert.equal(actual.length, expectedValues.length);
  return expectedValues.reduce(
    (largest, value, i) =>
      Math.max(
        largest,
        Math.abs((actual[i] ?? Number.NaN) - value) / (scales[i] ?? 1),
      ),
    0,
  );
}

// max(1, sum |x_i c_i| + |b|) for each row: the size of the terms of a
// prediction.
function predictionScales(
  rows: readonly Float32Array[],
  coef: readonly number[],
  intercept: number,
): number[] {
  return rows.map((row) =>
    Math.max(
      1,
      coef.reduce(
        (total, c, i) => total + Math.abs((row[i] ?? 0) * c),
        Math.abs(intercept),
      ),
    ),
  );
}

const relative = (values: readonly number[]) =>
  values.map((value) => Math.max(1, Math.abs(value)));

for (const kase of expected.linear_regression)
  test(`LinearRegression of ${kase.case} has the rank of scikit-learn, and its coefficients, singular values and predictions are within the tolerance of the float32 lstsq of Accelerate`, () => {
    const { x, xTest } = dataOf(kase);

    const model = new LinearRegression().fit(x, kase.y);

    const s0 = kase.singular[0] ?? 0;
    const differences = {
      coef: largestDifference(model.coef, kase.coef, relative(kase.coef)),
      intercept: largestDifference(
        [model.intercept],
        [kase.intercept],
        relative([kase.intercept]),
      ),
      singular: largestDifference(
        model.singular,
        kase.singular,
        kase.singular.map(() => s0),
      ),
      predictions: largestDifference(
        model.predict(xTest),
        kase.predictions,
        predictionScales(xTest, kase.coef, kase.intercept),
      ),
    };
    assert.equal(model.rank, kase.rank);
    assert.ok(
      differences.coef <= 1e-4 &&
        differences.intercept <= 1e-4 &&
        differences.singular <= 1e-5 &&
        differences.predictions <= 1e-4,
      JSON.stringify(differences),
    );
  });

test('predict with the coefficients of scikit-learn gives its predictions within 2^-21 of the size of the terms, as BLAS adds the products in another order', () => {
  const actual = expected.linear_regression.map((kase) => {
    const { xTest } = dataOf(kase);
    const model = new FittedLinearRegression(
      Float32Array.from(kase.coef),
      kase.intercept,
      kase.rank,
      Float32Array.from(kase.singular),
    );
    return largestDifference(
      model.predict(xTest),
      kase.predictions,
      predictionScales(xTest, kase.coef, kase.intercept),
    );
  });

  assert.ok(
    actual.every((difference) => difference <= 2 ** -21),
    JSON.stringify(actual),
  );
});
