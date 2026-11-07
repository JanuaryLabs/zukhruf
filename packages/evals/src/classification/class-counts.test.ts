import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BinaryAverage, ClassCounts, LabelComparison } from './index.ts';

test('BinaryAverage throws as scikit-learn raises: for more than two classes, for a set of classes, and for a positive label that is not one of two classes', () => {
  const multiclass = ClassCounts.of({ expected: [0, 1, 2], stated: [0, 1, 1] });
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
  const binary = ClassCounts.of({ expected: [0, 1], stated: [1, 1] });

  assert.throws(
    () => multiclass.precision({ average: new BinaryAverage(1) }),
    /The target is multiclass, but the average is binary/,
  );
  assert.throws(
    () => multilabel.precision({ average: new BinaryAverage(1) }),
    /The target is multilabel-indicator, but the average is binary/,
  );
  assert.throws(
    () => binary.precision({ average: new BinaryAverage(2) }),
    /The positive label 2 is not one of the labels \[0,1\]/,
  );
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
    () => ClassCounts.of({ expected: [0, 1], stated: [0] }),
    /have 2, 1 and 2 answers/,
  );
  assert.throws(
    () => ClassCounts.of({ expected: [0], stated: [0, 1] }),
    /have 1, 2 and 1 answers/,
  );
  assert.throws(
    () => ClassCounts.of({ expected: [0], stated: [0], weights: [1, 1] }),
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
  });

  assert.throws(
    () => new ClassCounts({ multilabel: false }).add(answer, 1),
    /Multiclass counts take one stated and one expected label for each answer, not \["a","b"\] and \["a"\]/,
  );
  const multilabel = new ClassCounts({ multilabel: true });
  multilabel.add(answer, 1);
  assert.deepEqual(multilabel.labels(), ['a', 'b']);
});
