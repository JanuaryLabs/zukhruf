import assert from 'node:assert/strict';
import { test } from 'node:test';

import { dayScores } from './daily.ts';

const article = (id: string, label: true | null | undefined) => ({
  id,
  publishedAt: new Date('2025-04-01T00:00:00Z'),
  text: '',
  label,
  narrow: false,
  broad: false,
});

test('daily recall counts the strict relevant articles of each day, and an ambiguous article is neither relevant nor wrong', () => {
  const articlesOn = new Map([
    [
      'd1',
      [
        article('a', true),
        article('b', true),
        article('amb', null),
        article('x', undefined),
      ],
    ],
    ['d2', [article('c', true), article('y', undefined)]],
    ['d3', [article('z', undefined)]],
  ]);
  const shown = new Map([
    ['d1', ['a', 'amb']],
    ['d2', ['y']],
    ['d3', []],
  ]);

  const scores = dayScores(
    ['d1', 'd2', 'd3'],
    (day) => shown.get(day) ?? [],
    articlesOn,
  );

  // Recall: d1 1/2, d2 0/1. Precision: d1 1/1 (amb left out), d2 0/1.
  assert.deepEqual(scores, {
    recall: 0.25,
    precision: 0.5,
    emptyDays: 1 / 3,
    missedDays: 0.5,
  });
});
