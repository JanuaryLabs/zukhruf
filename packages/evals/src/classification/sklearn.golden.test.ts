import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';

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
  type Average,
  BinaryAverage,
  BrierScore,
  ClassCounts,
  ClassMatches,
  type Label,
  LabelCase,
  LabelComparer,
  type LabelComparison,
  LabelsMatch,
  MacroAverage,
  MicroAverage,
  PerClass,
  ProbabilityComparer,
  SquaredErrorForm,
  WeightedAverage,
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
  readonly binary?: Scores & { readonly pos_label: Label };
  readonly confusion_matrix?: readonly (readonly number[])[];
};
type Call = {
  readonly case: string;
  readonly metric: 'precision' | 'recall' | 'fbeta';
  readonly y_true: readonly Label[];
  readonly y_pred: readonly Label[];
  readonly kwargs: {
    readonly average: 'micro' | 'macro' | 'weighted' | 'binary' | null;
    readonly beta?: number;
    readonly labels?: readonly Label[];
    readonly zero_division?: Value;
    readonly pos_label?: Label;
    readonly sample_weight?: readonly number[];
  };
  readonly value: Value | readonly Value[];
};
type Brier = {
  readonly case: string;
  readonly y_true: readonly Label[];
  readonly y_proba: readonly (number | readonly number[])[];
  readonly sample_weight: readonly number[] | null;
  readonly pos_label: Label | null;
  readonly value: number;
};
type SquaredError = {
  readonly case: string;
  readonly y_true: readonly (0 | 1)[];
  readonly p: readonly number[];
  readonly value: number;
};
type Expected = {
  readonly multiclass: readonly Sklearn[];
  readonly calls: readonly Call[];
  readonly multilabel: readonly Sklearn[];
  readonly brier: readonly Brier[];
  readonly squared_error: readonly SquaredError[];
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

const number = (value: Value) => (value === 'NaN' ? Number.NaN : value);
const averages = {
  micro: new MicroAverage(),
  macro: new MacroAverage(),
  weighted: new WeightedAverage(),
} as const;

// The counts of a case: of the labels of each answer, or of the rows of its
// label indicator matrices.
const countsOf = (sklearn: Sklearn): ClassCounts => {
  const weights =
    sklearn.sample_weight === null || sklearn.sample_weight === undefined
      ? {}
      : { weights: sklearn.sample_weight };
  const rows = (y: Sklearn['y_true']) =>
    y.map((row) => {
      assert.ok(typeof row === 'object');
      return row;
    });
  return sklearn.labels === undefined
    ? ClassCounts.ofIndicators({
        expected: rows(sklearn.y_true),
        stated: rows(sklearn.y_pred),
        ...weights,
      })
    : ClassCounts.of({
        expected: sklearn.y_true.map((label) => {
          assert.ok(typeof label !== 'object');
          return label;
        }),
        stated: sklearn.y_pred.map((label) => {
          assert.ok(typeof label !== 'object');
          return label;
        }),
        ...weights,
      });
};

// The precision, recall and F1 of the counts: of the selected classes, with
// the average.
const scoresOf = (
  counts: ClassCounts,
  average: Average,
  labels?: readonly Label[],
) => {
  const options = labels === undefined ? { average } : { average, labels };
  return {
    precision: counts.precision(options),
    recall: counts.recall(options),
    f1: counts.fBeta({ beta: 1, ...options }),
  };
};

test("ClassCounts gives scikit-learn's accuracy, the micro, macro and weighted precision, recall and F1, the score of each class and the support, bit for bit, with float sample weights too, for a class and for a set of classes", () => {
  const differ: string[] = [];

  for (const sklearn of [...expected.multiclass, ...expected.multilabel]) {
    const counts = countsOf(sklearn);
    const got = {
      accuracy: counts.accuracy(),
      ...Object.fromEntries(
        Object.entries(averages).map(([name, average]) => [
          name,
          scoresOf(counts, average),
        ]),
      ),
      none: {
        ...Object.fromEntries(
          (['precision', 'recall', 'f1'] as const).map((metric) => [
            metric,
            classes(sklearn).map(
              (label) => scoresOf(counts, new MacroAverage(), [label])[metric],
            ),
          ]),
        ),
        support: [...counts.support().values()],
      },
    };
    const want = {
      accuracy: sklearn.accuracy,
      micro: sklearn.micro,
      macro: sklearn.macro,
      weighted: sklearn.weighted,
      none: sklearn.none,
    };
    if (!isDeepStrictEqual(got, want)) differ.push(sklearn.case);
  }

  assert.deepEqual(differ, []);
});

test("BinaryAverage gives scikit-learn's average='binary' of the positive label for answers of two labels or fewer", () => {
  const differ: string[] = [];

  for (const sklearn of expected.multiclass) {
    if (sklearn.binary === undefined) continue;
    const { pos_label, ...want } = sklearn.binary;
    const got = scoresOf(countsOf(sklearn), new BinaryAverage(pos_label));
    if (!isDeepStrictEqual(got, want)) differ.push(sklearn.case);
  }

  assert.deepEqual(differ, []);
});

test("confusionMatrix gives scikit-learn's confusion_matrix: a row for each expected label and a column for each stated label, in the order of the labels", () => {
  const differ = expected.multiclass
    .filter((sklearn) => {
      const matrix = countsOf(sklearn).confusionMatrix();
      return !isDeepStrictEqual(
        [matrix.labels, matrix.rows()],
        [sklearn.labels, sklearn.confusion_matrix],
      );
    })
    .map((sklearn) => sklearn.case);

  assert.deepEqual(differ, []);
});

test("ClassCounts gives scikit-learn's value for each call with labels, zero_division 0, 1 or NaN, beta 0.5, 0.3 or 2, and the binary average", () => {
  const differ: string[] = [];

  for (const call of expected.calls) {
    const { average, beta, labels, zero_division, pos_label, sample_weight } =
      call.kwargs;
    const counts = ClassCounts.of({
      expected: call.y_true,
      stated: call.y_pred,
      ...(sample_weight === undefined ? {} : { weights: sample_weight }),
    });
    const score = (options: {
      readonly average: Average;
      readonly labels?: readonly Label[];
    }) => {
      const all = {
        ...options,
        ...(zero_division === undefined
          ? {}
          : { zeroDivision: number(zero_division) }),
      };
      if (call.metric === 'fbeta')
        return counts.fBeta({ beta: beta ?? Number.NaN, ...all });
      return counts[call.metric](all);
    };
    const value =
      average === null
        ? (labels ?? counts.labels()).map((label) =>
            score({ average: new MacroAverage(), labels: [label] }),
          )
        : score({
            average:
              average === 'binary'
                ? new BinaryAverage(pos_label ?? 1)
                : averages[average],
            ...(labels === undefined ? {} : { labels }),
          });
    const want =
      typeof call.value === 'object'
        ? call.value.map(number)
        : number(call.value);
    if (!isDeepStrictEqual(value, want))
      differ.push(`${call.case}: ${call.metric} ${average}`);
  }

  assert.deepEqual(differ, []);
});

// The comparisons of a Brier case, as an answer gives them: an object of the
// probability of each label, or of the positive label only.
const probabilitiesOf = (brier: Brier) => {
  const labels = [...new Set(brier.y_true)].toSorted((left, right) =>
    typeof left === 'number' && typeof right === 'number'
      ? left - right
      : String(left) < String(right)
        ? -1
        : 1,
  );
  return brier.y_true.map((label, index) => {
    const row = brier.y_proba[index] ?? [];
    const stated =
      typeof row === 'number'
        ? { [String(brier.pos_label)]: row }
        : Object.fromEntries(
            labels.map((name, column) => [String(name), row[column]]),
          );
    return new ProbabilityComparer().compare(
      JSON.stringify(stated),
      new LabelCase({ expected: label, weight: 1 }),
    );
  });
};

test("BrierScore gives scikit-learn's brier_score_loss bit for bit: of the positive label, of a column for each of two, three and 12 labels, and with float sample weights", () => {
  const differ = expected.brier
    .filter((brier) => {
      const score = new BrierScore(
        brier.pos_label === null ? {} : { positiveLabel: brier.pos_label },
      );
      const value =
        brier.sample_weight === null
          ? score.mean(probabilitiesOf(brier))
          : score.mean(probabilitiesOf(brier), brier.sample_weight);
      return !Object.is(value, brier.value);
    })
    .map((brier) => brier.case);

  assert.deepEqual(differ, []);
});

test("the ratio of BrierScore for one answer is its score over 1, scikit-learn's brier_score_loss of that answer", () => {
  const brier = expected.brier.find(({ case: name }) => name === 'one answer');
  assert.ok(brier);
  const [comparison] = probabilitiesOf(brier);
  assert.ok(comparison);

  const ratio = new BrierScore({ positiveLabel: 1 }).score(comparison);

  assert.deepEqual([ratio.part, ratio.whole], [brier.value, 1]);
});

test("BrierScore with the SquaredErrorForm gives numpy's np.mean((p - y) ** 2) bit for bit, also where scikit-learn's form differs in the last bit", () => {
  const differ = expected.squared_error
    .filter(({ y_true, p, value }) => {
      const comparisons = y_true.map((label, index) =>
        new ProbabilityComparer().compare(
          { 1: p[index] },
          new LabelCase({ expected: label, weight: 1 }),
        ),
      );
      const score = new BrierScore({
        positiveLabel: 1,
        form: new SquaredErrorForm(),
      });
      return !Object.is(score.mean(comparisons), value);
    })
    .map(({ case: name }) => name);

  assert.deepEqual(differ, []);
});
