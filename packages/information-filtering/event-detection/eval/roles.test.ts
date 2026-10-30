import assert from 'node:assert/strict';
import { test } from 'node:test';

import { decide } from './roles.ts';

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

test('in an exam run, an exam set that was scored once runs as a regression set, so it is never an exam again', () => {
  const decision = decide(
    { role: 'exam', firstScoredAt: '2026-10-28T00:00:00Z' },
    true,
  );

  assert.deepEqual(decision, {
    run: true,
    role: 'regression',
    firstScore: false,
  });
});
