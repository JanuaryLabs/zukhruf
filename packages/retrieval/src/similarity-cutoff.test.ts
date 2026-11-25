import assert from 'node:assert/strict';

import { test } from '@zukhruf/testing/node';

import { SimilarityCutoff } from './index.ts';

const scored = (id: string, score: number) => ({
  passage: { id, text: id, source: id, seq: 0, start: 0, end: 0, metadata: {} },
  score,
});

test('a SimilarityCutoff keeps the passages whose score is at least the threshold, in their order', async () => {
  // Arrange
  const cutoff = new SimilarityCutoff({ threshold: 0.5 });

  // Act
  const results = await cutoff.postprocess([
    scored('c', 0.5),
    scored('b', 0.49),
    scored('a', 0.9),
    scored('d', 0.1),
  ]);

  // Assert: 0.5 equals the threshold and stays; 0.49 and 0.1 are below it.
  // The list is not sorted by score, and the cutoff does not sort it.
  assert.deepEqual(
    results.map(({ passage, score }) => [passage.id, score]),
    [
      ['c', 0.5],
      ['a', 0.9],
    ],
  );
});

test('a SimilarityCutoff drops a passage without a score, as LlamaIndex drops a node whose score is None, even under a threshold that every score passes', async () => {
  // Arrange
  const cutoff = new SimilarityCutoff({ threshold: Number.NEGATIVE_INFINITY });
  const unscored = {
    passage: { id: 'web', text: 'web', metadata: {} },
  };

  // Act
  const results = await cutoff.postprocess([
    scored('a', -5),
    unscored,
    scored('b', 0),
  ]);

  // Assert
  assert.deepEqual(
    results.map(({ passage }) => passage.id),
    ['a', 'b'],
  );
});

void test.each(
  [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
  (score) =>
    test(`a SimilarityCutoff refuses a passage whose score is ${score} with a TypeError that names the passage, where it dropped NaN and kept Infinity (#5700)`, async () => {
      // Arrange
      const cutoff = new SimilarityCutoff({ threshold: 0.5 });
      const passages = [
        scored('a', 0.9),
        scored('broken', score),
        scored('b', 0.1),
      ];

      // Act and Assert
      await assert.rejects(cutoff.postprocess(passages), {
        name: 'TypeError',
        message: `SimilarityCutoff reads scores, and the passage broken has the score ${score}: a score is a finite number`,
      });
    }),
);
