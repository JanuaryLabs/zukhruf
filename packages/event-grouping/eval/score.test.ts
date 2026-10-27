import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AnswerRow } from './answer-key.ts';
import { score } from './score.ts';

test('pair scores of one publisher and of two publishers split the pairs by the publishers of their reports', () => {
  // Gold events x = {a, c, d} and y = {b}; the detector made {a, b} and
  // {c, d}. a and c are of publisher p, b and d of publisher q.
  const rows: AnswerRow[] = [
    ['a', 'x', 'p'],
    ['b', 'y', 'q'],
    ['c', 'x', 'p'],
    ['d', 'x', 'q'],
  ].map(([id, event, publisher]) => ({
    id: id!,
    source: `https://example.com/${id}`,
    publishedAt: '2026-10-27T00:00:00Z',
    publisher: publisher!,
    event: event!,
    textSha256: '',
  }));
  const eventOf = new Map([
    ['a', '1'],
    ['b', '1'],
    ['c', '2'],
    ['d', '2'],
  ]);

  const result = score(rows, new Map(), eventOf, []);

  // Two publishers: a-b joined wrong, c-d joined right, a-d missed, b-c
  // apart in both.
  assert.deepEqual(
    [result.crossPublisher?.precision, result.crossPublisher?.recall],
    [1 / 2, 1 / 2],
  );
  // One publisher: a-c missed, b-d apart in both.
  assert.deepEqual(
    [result.samePublisher?.precision, result.samePublisher?.recall],
    [0, 0],
  );
});
