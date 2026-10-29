import assert from 'node:assert/strict';
import { test } from 'node:test';

import { averagePrecision, newestFirst } from './ranking.ts';

test('average precision leaves out the ambiguous articles and averages the precision at each relevant article', () => {
  const labels = new Map([
    ['a', true as const],
    ['amb', null],
    ['b', undefined],
    ['c', true as const],
  ]);

  // Without the ambiguous article: a (1/1), b, c (2/3).
  assert.equal(
    averagePrecision(['a', 'amb', 'b', 'c'], labels),
    (1 + 2 / 3) / 2,
  );
});

test('an article drawn two times takes two ranks next to each other, and an article not drawn takes none', () => {
  const labels = new Map([
    ['a', undefined],
    ['b', true as const],
    ['c', true as const],
  ]);
  const weights = new Map([
    ['a', 1],
    ['b', 2],
    ['c', 0],
  ]);

  // a, b, b: the relevant copies sit at ranks 2 and 3.
  assert.equal(
    averagePrecision(['a', 'b', 'c'], labels, weights),
    (1 / 2 + 2 / 3) / 2,
  );
  assert.ok(Number.isNaN(averagePrecision(['a'], labels)));
});

test('a keyword list puts the matches first, the newest first inside each group, and equal dates by id', () => {
  const at = (id: string, day: number, narrow: boolean) => ({
    id,
    publishedAt: new Date(Date.UTC(2025, 6, day)),
    text: '',
    label: undefined,
    narrow,
    broad: false,
  });
  const stream = [
    at('old-match', 1, true),
    at('new', 3, false),
    at('b', 2, true),
    at('a', 2, true),
    at('older', 1, false),
  ];

  assert.deepEqual(
    newestFirst(stream, ({ narrow }) => narrow),
    ['a', 'b', 'old-match', 'new', 'older'],
  );
  assert.deepEqual(
    newestFirst(stream, () => false),
    ['new', 'a', 'b', 'old-match', 'older'],
  );
});
