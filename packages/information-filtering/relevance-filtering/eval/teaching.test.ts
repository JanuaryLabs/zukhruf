import assert from 'node:assert/strict';
import { test } from 'node:test';

import { teach } from './teaching.ts';

test('the reader shows the n most similar articles and the n most similar keyword matches, and skips an ambiguous answer', () => {
  const pool = [
    { id: 'a', similarity: 0.9, match: false, label: true as const },
    { id: 'b', similarity: 0.5, match: true, label: undefined },
    { id: 'c', similarity: 0.8, match: false, label: undefined },
    { id: 'd', similarity: 0.4, match: true, label: null },
    { id: 'e', similarity: 0.3, match: true, label: true as const },
    { id: 'f', similarity: 0.1, match: false, label: undefined },
  ];

  const answers = teach(pool, 2);

  assert.deepEqual(answers, {
    shown: ['a', 'b', 'c', 'd'],
    relevant: ['a'],
    notRelevant: ['b', 'c'],
  });
});

test('equal similarities keep the order of the pool', () => {
  const pool = ['x', 'y', 'z'].map((id) => ({
    id,
    similarity: 0.5,
    match: false,
    label: true as const,
  }));

  assert.deepEqual(teach(pool, 2).shown, ['x', 'y']);
});
