import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AnswerRow } from '../answer-key.ts';
import { type LoadedSet, foldsOf } from './folds.ts';

function row(id: string, event: string, publishedAt: string | null): AnswerRow {
  return {
    id,
    source: `https://news.example/${id}`,
    publishedAt,
    event,
    textSha256: id,
  };
}

function set(name: string, rows: readonly AnswerRow[]): LoadedSet {
  return {
    name,
    rows,
    texts: new Map(rows.map((r) => [r.id, { title: r.id, body: '' }])),
  };
}

function members(folds: ReturnType<typeof foldsOf>): string[][] {
  return folds.map((fold) => fold.rows.map((r) => r.id).toSorted());
}

test('time folds hold whole gold events, in the order of their first publish dates, about rows / count reports each', () => {
  // 8 reports, 2 folds of about 4. A (3 reports) and B (1) come first, then
  // C and D. A has a late report, which stays with A. The rows are not in
  // time order.
  const rows = [
    row('d1', 'D', '2026-01-04T00:00:00Z'),
    row('a3', 'A', '2026-01-09T00:00:00Z'),
    row('c1', 'C', '2026-01-03T00:00:00Z'),
    row('a1', 'A', '2026-01-01T00:00:00Z'),
    row('b1', 'B', '2026-01-02T00:00:00Z'),
    row('c2', 'C', '2026-01-03T12:00:00Z'),
    row('a2', 'A', '2026-01-01T06:00:00Z'),
    row('d2', 'D', '2026-01-05T00:00:00Z'),
  ];

  const folds = foldsOf(
    [{ family: 'outlets', sets: ['outlets'], split: 'time', count: 2 }],
    new Map([['outlets', set('outlets', rows)]]),
  );

  assert.deepEqual(
    folds.map((fold) => [fold.name, fold.family]),
    [
      ['outlets-0', 'outlets'],
      ['outlets-1', 'outlets'],
    ],
  );
  assert.deepEqual(members(folds), [
    ['a1', 'a2', 'a3', 'b1'],
    ['c1', 'c2', 'd1', 'd2'],
  ]);
});

test('topic folds go by the rank of the topic number, not of its text, mod count', () => {
  // Topics 3, 7 and 10 have the ranks 0, 1 and 2. As text, 10 sorts first.
  const rows = [
    row('ecb-10_1ecb', 'ten', null),
    row('ecb-3_1ecb', 'three', null),
    row('ecb-7_2ecbplus', 'seven', null),
    row('ecb-3_4ecbplus', 'three', null),
  ];

  const folds = foldsOf(
    [{ family: 'ecb', sets: ['ecb'], split: 'topic', count: 2 }],
    new Map([['ecb', set('ecb', rows)]]),
  );

  assert.deepEqual(members(folds), [
    ['ecb-10_1ecb', 'ecb-3_1ecb', 'ecb-3_4ecbplus'],
    ['ecb-7_2ecbplus'],
  ]);
});

test('a fold of no split holds every report of its sets, with the texts of each set', () => {
  const first = set('first', [row('f1', 'X', null)]);
  const second = set('second', [row('s1', 'Y', '2026-01-01T00:00:00Z')]);

  const [fold, ...rest] = foldsOf(
    [{ family: 'small', sets: ['first', 'second'], split: 'none', count: 1 }],
    new Map([
      ['first', first],
      ['second', second],
    ]),
  );

  assert.equal(rest.length, 0);
  assert.deepEqual(
    fold?.rows.map((r) => r.id),
    ['f1', 's1'],
  );
  assert.deepEqual([...(fold?.texts.keys() ?? [])], ['f1', 's1']);
});

test('a set that the fit did not load, a time fold row with no date and an id with no ECB+ topic are refused', () => {
  const dated = set('outlets', [row('a1', 'A', null)]);
  const ecb = set('ecb', [row('wcep-1', 'A', null)]);

  assert.throws(
    () =>
      foldsOf(
        [{ family: 'x', sets: ['missing'], split: 'none', count: 1 }],
        new Map(),
      ),
    /The fit loaded no set missing/u,
  );
  assert.throws(
    () =>
      foldsOf(
        [{ family: 'x', sets: ['outlets'], split: 'time', count: 1 }],
        new Map([['outlets', dated]]),
      ),
    /a1 has no date for a time fold/u,
  );
  assert.throws(
    () =>
      foldsOf(
        [{ family: 'x', sets: ['ecb'], split: 'topic', count: 1 }],
        new Map([['ecb', ecb]]),
      ),
    /wcep-1 names no ECB\+ topic/u,
  );
});
