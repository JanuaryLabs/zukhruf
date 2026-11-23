import assert from 'node:assert/strict';
import { test } from 'node:test';

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
