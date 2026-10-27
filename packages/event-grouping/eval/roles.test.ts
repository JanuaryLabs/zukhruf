import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decide } from './roles.ts';
import { Scoreboard, type SetEntry } from './scoreboard.ts';

test('a training set runs, and its first run records the first-scored date', () => {
  const decision = decide({ role: 'training', firstScoredAt: null }, false);

  assert.deepEqual(decision, { run: true, role: 'training', firstScore: true });
});

test('a regression set that was scored before runs as a regression set', () => {
  const decision = decide(
    { role: 'regression', firstScoredAt: '2026-10-26T19:59:05Z' },
    false,
  );

  assert.deepEqual(decision, {
    run: true,
    role: 'regression',
    firstScore: false,
  });
});

test('an exam set that was never scored is skipped unless the caller asks for the exam', () => {
  const decision = decide({ role: 'exam', firstScoredAt: null }, false);

  assert.equal(decision.run, false);
});

test('an exam set that was never scored runs as the exam when the caller asks, and the run is its first score', () => {
  const decision = decide({ role: 'exam', firstScoredAt: null }, true);

  assert.deepEqual(decision, { run: true, role: 'exam', firstScore: true });
});

test('an exam set that was scored once runs as a regression set', () => {
  const decision = decide(
    { role: 'exam', firstScoredAt: '2026-10-28T00:00:00Z' },
    false,
  );

  assert.deepEqual(decision, {
    run: true,
    role: 'regression',
    firstScore: false,
  });
});

test('an exam set that was scored once refuses to be an exam again', () => {
  assert.throws(
    () => decide({ role: 'exam', firstScoredAt: '2026-10-28T00:00:00Z' }, true),
    /cannot be an exam again/u,
  );
});

function setEntry(
  role: SetEntry['role'],
  labelsSha256: string,
  pairF05: number,
  bcubedF05: number,
): SetEntry {
  return {
    role,
    labelsSha256,
    reports: 10,
    pair: { precision: 0.5, recall: 0.5, f05: pairF05 },
    bcubed: { precision: 0.5, recall: 0.5, f05: bcubedF05 },
  };
}

test('a regression set with a lower F0.5 than the latest accepted design is refused', () => {
  // Design 3130 is the latest design that scored gvc; design 3140 scored
  // only ecbplus.
  const accepted = new Scoreboard([
    {
      design: '3120',
      acceptedAt: '2026-10-20T00:00:00Z',
      embeddingModel: 'embeddinggemma-2',
      sets: { gvc: setEntry('regression', 'labels-1', 0.5, 0.5) },
    },
    {
      design: '3130',
      acceptedAt: '2026-10-27T00:00:00Z',
      embeddingModel: 'embeddinggemma-2',
      sets: {
        gvc: setEntry('regression', 'labels-1', 0.868, 0.948),
        ecbplus: setEntry('training', 'labels-2', 0.866, 0.915),
      },
    },
    {
      design: '3140',
      acceptedAt: '2026-10-28T00:00:00Z',
      embeddingModel: 'embeddinggemma-2',
      sets: { ecbplus: setEntry('training', 'labels-2', 0.9, 0.9) },
    },
  ]);

  const reason = accepted.worse(
    'gvc',
    setEntry('regression', 'labels-1', 0.868, 0.947),
  );

  assert.match(reason ?? '', /bcubed F0\.5 is lower than design 3130/u);
});

test('a regression set whose pair F0.5 alone is lower than the latest accepted design is refused', () => {
  // Design 3130 is the latest design that scored gvc; design 3140 scored
  // only ecbplus.
  const accepted = new Scoreboard([
    {
      design: '3120',
      acceptedAt: '2026-10-20T00:00:00Z',
      embeddingModel: 'embeddinggemma-2',
      sets: { gvc: setEntry('regression', 'labels-1', 0.5, 0.5) },
    },
    {
      design: '3130',
      acceptedAt: '2026-10-27T00:00:00Z',
      embeddingModel: 'embeddinggemma-2',
      sets: {
        gvc: setEntry('regression', 'labels-1', 0.868, 0.948),
        ecbplus: setEntry('training', 'labels-2', 0.866, 0.915),
      },
    },
    {
      design: '3140',
      acceptedAt: '2026-10-28T00:00:00Z',
      embeddingModel: 'embeddinggemma-2',
      sets: { ecbplus: setEntry('training', 'labels-2', 0.9, 0.9) },
    },
  ]);

  const reason = accepted.worse(
    'gvc',
    setEntry('regression', 'labels-1', 0.867, 0.948),
  );

  assert.match(reason ?? '', /its pair F0\.5 is lower than design 3130/u);
});

test('a regression set with equal scores is not refused', () => {
  // Design 3130 is the latest design that scored gvc; design 3140 scored
  // only ecbplus.
  const accepted = new Scoreboard([
    {
      design: '3120',
      acceptedAt: '2026-10-20T00:00:00Z',
      embeddingModel: 'embeddinggemma-2',
      sets: { gvc: setEntry('regression', 'labels-1', 0.5, 0.5) },
    },
    {
      design: '3130',
      acceptedAt: '2026-10-27T00:00:00Z',
      embeddingModel: 'embeddinggemma-2',
      sets: {
        gvc: setEntry('regression', 'labels-1', 0.868, 0.948),
        ecbplus: setEntry('training', 'labels-2', 0.866, 0.915),
      },
    },
    {
      design: '3140',
      acceptedAt: '2026-10-28T00:00:00Z',
      embeddingModel: 'embeddinggemma-2',
      sets: { ecbplus: setEntry('training', 'labels-2', 0.9, 0.9) },
    },
  ]);

  const reason = accepted.worse(
    'gvc',
    setEntry('regression', 'labels-1', 0.868, 0.948),
  );

  assert.equal(reason, null);
});

test('a training set may score lower than the latest accepted design', () => {
  // Design 3130 is the latest design that scored gvc; design 3140 scored
  // only ecbplus.
  const accepted = new Scoreboard([
    {
      design: '3120',
      acceptedAt: '2026-10-20T00:00:00Z',
      embeddingModel: 'embeddinggemma-2',
      sets: { gvc: setEntry('regression', 'labels-1', 0.5, 0.5) },
    },
    {
      design: '3130',
      acceptedAt: '2026-10-27T00:00:00Z',
      embeddingModel: 'embeddinggemma-2',
      sets: {
        gvc: setEntry('regression', 'labels-1', 0.868, 0.948),
        ecbplus: setEntry('training', 'labels-2', 0.866, 0.915),
      },
    },
    {
      design: '3140',
      acceptedAt: '2026-10-28T00:00:00Z',
      embeddingModel: 'embeddinggemma-2',
      sets: { ecbplus: setEntry('training', 'labels-2', 0.9, 0.9) },
    },
  ]);

  const reason = accepted.worse(
    'ecbplus',
    setEntry('training', 'labels-2', 0.5, 0.5),
  );

  assert.equal(reason, null);
});

test('a regression score on fixed labels is not compared with a score on the old labels', () => {
  // Design 3130 is the latest design that scored gvc; design 3140 scored
  // only ecbplus.
  const accepted = new Scoreboard([
    {
      design: '3120',
      acceptedAt: '2026-10-20T00:00:00Z',
      embeddingModel: 'embeddinggemma-2',
      sets: { gvc: setEntry('regression', 'labels-1', 0.5, 0.5) },
    },
    {
      design: '3130',
      acceptedAt: '2026-10-27T00:00:00Z',
      embeddingModel: 'embeddinggemma-2',
      sets: {
        gvc: setEntry('regression', 'labels-1', 0.868, 0.948),
        ecbplus: setEntry('training', 'labels-2', 0.866, 0.915),
      },
    },
    {
      design: '3140',
      acceptedAt: '2026-10-28T00:00:00Z',
      embeddingModel: 'embeddinggemma-2',
      sets: { ecbplus: setEntry('training', 'labels-2', 0.9, 0.9) },
    },
  ]);

  const reason = accepted.worse(
    'gvc',
    setEntry('regression', 'labels-fixed', 0.5, 0.5),
  );

  assert.equal(reason, null);
});
