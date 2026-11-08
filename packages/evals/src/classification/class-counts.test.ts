import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Recall, ScorerSet } from '../index.ts';
import {
  AllClassMatches,
  BinaryAverage,
  ClassCounts,
  LabelCase,
  LabelComparer,
  LabelComparison,
  LabelsMatch,
  MicroAverage,
  PerClass,
} from './index.ts';

test('the answer null with number labels is a miss of its expected class and a wrong answer, and no class: the counts, the comparer and its scorers no longer throw for a number and a string', () => {
  const counts = ClassCounts.of({
    labels: [0, 1],
    expected: [1, 0, 1],
    stated: ['null', 0, 1],
  });
  const scorer = new ScorerSet(
    {
      accuracy: new LabelsMatch(),
      recall: new Recall(new AllClassMatches()),
      kinds: new PerClass(new Recall(new AllClassMatches())),
    },
    { comparer: new LabelComparer({ labels: [0, 1] }) },
  );
  const comparer = new LabelComparer({ labels: [0, 1] });
  const run = new ClassCounts({ labels: [0, 1], multilabel: false });

  const scorecard = scorer.score(
    'null',
    new LabelCase({ expected: 1, weight: 1 }),
  );
  run.add(
    comparer.compare('null', new LabelCase({ expected: 1, weight: 1 })),
    1,
  );

  assert.deepEqual(
    {
      accuracy: counts.accuracy(),
      precision: counts.precision({ average: new MicroAverage() }),
      recall: counts.recall({ average: new MicroAverage() }),
      support: [...counts.support()],
    },
    {
      accuracy: 2 / 3,
      precision: 1,
      recall: 2 / 3,
      support: [
        [0, 1],
        [1, 2],
      ],
    },
  );
  assert.deepEqual(
    [
      scorecard.passed,
      [...scorecard.ratios].map(([name, { part, whole }]) => [
        name,
        part,
        whole,
      ]),
    ],
    [
      false,
      [
        ['accuracy', 0, 1],
        ['recall', 0, 1],
        ['1 kinds', 0, 1],
      ],
    ],
  );
  assert.deepEqual(
    [run.accuracy(), [...run.support()]],
    [
      0,
      [
        [0, 0],
        [1, 1],
      ],
    ],
  );
});

test('the confusion matrix and the support have the classes of the class set in its order, and the matrix has no pair with a stated label outside it', () => {
  const counts = ClassCounts.of({
    labels: ['b', 'a'],
    expected: ['a', 'b', 'a', 'b'],
    stated: ['b', 'b', 'null', 'a'],
  });

  const matrix = counts.confusionMatrix();

  assert.deepEqual(
    {
      labels: counts.labels(),
      support: [...counts.support()],
      matrix: [matrix.labels, matrix.rows()],
      null: matrix.count('a', 'null'),
    },
    {
      labels: ['b', 'a'],
      support: [
        ['b', 2],
        ['a', 2],
      ],
      matrix: [
        ['b', 'a'],
        [
          [1, 1],
          [1, 0],
        ],
      ],
      null: 0,
    },
  );
});

test('BinaryAverage reads the class set and throws as scikit-learn raises: for a class set of more than two classes, also when the answers have two, for a set of classes, and for a positive label outside the class set, also when an answer states it', () => {
  const multiclass = ClassCounts.of({
    labels: [0, 1, 2],
    expected: [0, 1, 1],
    stated: [0, 1, 1],
  });
  const multilabel = ClassCounts.ofIndicators({
    expected: [
      [1, 0],
      [1, 1],
    ],
    stated: [
      [1, 0],
      [0, 1],
    ],
  });
  const binary = ClassCounts.of({
    labels: [0, 1],
    expected: [0, 1],
    stated: [2, 1],
  });

  assert.throws(
    () => multiclass.precision({ average: new BinaryAverage(1) }),
    /The class set has 3 classes, but the average is binary/,
  );
  assert.throws(
    () => multilabel.precision({ average: new BinaryAverage(1) }),
    /The target is multilabel-indicator, but the average is binary/,
  );
  assert.throws(
    () => binary.precision({ average: new BinaryAverage(2) }),
    /The positive label 2 is not in the class set \[0,1\]/,
  );
});

test('the class set is required: counts, a comparer and a score without it, or a score with its own labels, do not compile', () => {
  // typecheck proves this test: an @ts-expect-error that has no error fails it.
  const illegal = [
    // @ts-expect-error The counts take the class set.
    () => new ClassCounts({ multilabel: false }),
    // @ts-expect-error The counts of two arrays take the class set.
    () => ClassCounts.of({ expected: [0], stated: [0] }),
    // @ts-expect-error The comparer takes the class set.
    () => new LabelComparer(),
    () =>
      ClassCounts.of({ labels: [0], expected: [0], stated: [0] }).precision({
        average: new MicroAverage(),
        // @ts-expect-error The counts have one class set.
        labels: [0],
      }),
  ];

  assert.equal(illegal.length, 4);
});

test('a set of classes has no confusion matrix, and ClassCounts refuses answers of unequal lengths and a row of a label indicator matrix that is not 0 or 1', () => {
  assert.throws(
    () =>
      ClassCounts.ofIndicators({
        expected: [[1, 0]],
        stated: [[1, 1]],
      }).confusionMatrix(),
    /no confusion matrix/,
  );
  assert.throws(
    () => ClassCounts.of({ labels: [0, 1], expected: [0, 1], stated: [0] }),
    /have 2, 1 and 2 answers/,
  );
  assert.throws(
    () => ClassCounts.of({ labels: [0, 1], expected: [0], stated: [0, 1] }),
    /have 1, 2 and 1 answers/,
  );
  assert.throws(
    () =>
      ClassCounts.of({
        labels: [0],
        expected: [0],
        stated: [0],
        weights: [1, 1],
      }),
    /have 1, 1 and 2 answers/,
  );
  assert.throws(
    () => ClassCounts.ofIndicators({ expected: [[1, 2]], stated: [[1, 0]] }),
    /holds 2 values of 0 or 1, not \[1,2\]/,
  );
});

test('multiclass counts refuse an answer with no label or more than one label on a side, which multilabel counts take', () => {
  const answer = new LabelComparison({
    stated: new Set(['a', 'b']),
    expected: new Set(['a']),
    labels: ['b', 'a'],
  });

  assert.throws(
    () =>
      new ClassCounts({ labels: ['b', 'a'], multilabel: false }).add(answer, 1),
    /Multiclass counts take one stated and one expected label for each answer, not \["a","b"\] and \["a"\]/,
  );
  const multilabel = new ClassCounts({ labels: ['b', 'a'], multilabel: true });
  multilabel.add(answer, 1);
  assert.deepEqual(
    [multilabel.labels(), [...multilabel.support()]],
    [
      ['b', 'a'],
      [
        ['b', 0],
        ['a', 1],
      ],
    ],
  );
});

test('an expected label outside the class set counts in no class: it is not a true count of any class, the matrix has no pair with it, the answer is wrong, and AllClassMatches does not count it as expected', () => {
  const counts = ClassCounts.of({
    labels: ['b', 'a'],
    expected: ['a', 'x'],
    stated: ['a', 'a'],
  });
  const comparison = new LabelComparer({ labels: ['b', 'a'] }).compare(
    'a',
    new LabelCase({ expected: 'x', weight: 1 }),
  );

  const matrix = counts.confusionMatrix();
  const matches = new AllClassMatches().counts(comparison);

  assert.deepEqual(
    {
      support: [...counts.support()],
      pair: matrix.count('x', 'a'),
      rows: matrix.rows(),
      accuracy: counts.accuracy(),
      recall: counts.recall({ average: new MicroAverage() }),
      precision: counts.precision({ average: new MicroAverage() }),
      matches: [matches.hits, matches.stated, matches.expected],
    },
    {
      support: [
        ['b', 0],
        ['a', 1],
      ],
      pair: 0,
      rows: [
        [0, 0],
        [0, 1],
      ],
      accuracy: 0.5,
      recall: 1,
      precision: 0.5,
      matches: [0, 1, 0],
    },
  );
});

test('a class set that holds the label "null" reads the answer null as that class', () => {
  const counts = ClassCounts.of({
    labels: ['a', 'null'],
    expected: ['a', 'a'],
    stated: ['a', 'null'],
  });

  assert.deepEqual(
    [
      [...counts.support()],
      counts.confusionMatrix().rows(),
      counts.precision({ average: new MicroAverage() }),
    ],
    [
      [
        ['a', 2],
        ['null', 0],
      ],
      [
        [1, 1],
        [0, 0],
      ],
      0.5,
    ],
  );
});

test('BinaryAverage reads a stated label outside a class set of two classes as a miss of the positive class, not as a third class', () => {
  const counts = ClassCounts.of({
    labels: [0, 1],
    expected: [1, 1, 0],
    stated: [1, 'null', 1],
  });

  assert.deepEqual(
    [
      counts.recall({ average: new BinaryAverage(1) }),
      counts.precision({ average: new BinaryAverage(1) }),
    ],
    [0.5, 0.5],
  );
});
