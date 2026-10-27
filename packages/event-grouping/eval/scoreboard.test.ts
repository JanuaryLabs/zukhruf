import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Interval } from './bootstrap.ts';
import { METRICS_VERSION } from './metrics/metrics.ts';
import {
  type Entry,
  type Pin,
  Scoreboard,
  type SetEntry,
} from './scoreboard.ts';

function setEntry(role: SetEntry['role'], labelsSha256: string): SetEntry {
  const score = { precision: 0.9, recall: 0.8, f1: 0.847, f05: 0.878 };
  return {
    role,
    labelsSha256,
    reports: 10,
    muc: score,
    bCubed: score,
    ceafE: score,
    blanc: score,
    pair: score,
    conll: { f1: 0.847, f05: 0.878 },
  };
}

function pin(threshold: number): Pin {
  return {
    commit: '73db0ed89276a53c9df1b5dc57b6a1c3ef90bba3',
    planSha256:
      '5ad0b727f8ae67a1f25bd25719e550952ab1449e3dce1fad551714f63a3ade4f',
    frozenDesignSha256: `sha-of-a-file-with-threshold-${threshold}`,
    constants: { THRESHOLD: threshold, WINDOW_DAYS: 7 },
  };
}

function entry(
  design: string,
  sets: Entry['sets'],
  threshold = 0.5,
  metricsVersion = METRICS_VERSION,
): Entry {
  return {
    design,
    acceptedAt: '2026-10-27T00:00:00Z',
    metricsVersion,
    embeddingModel: 'embeddinggemma-2',
    pin: pin(threshold),
    sets,
  };
}

function change(observed: number, low: number, high: number): Interval {
  return { observed, low, high, blocks: 200, replicates: 2000, seed: 3182 };
}

test('a regression set is refused when the whole 95% interval of the change of the main score is below 0', () => {
  // Design 3130 is the latest design that scored gvc; design 3140 scored
  // only ecbplus.
  const accepted = new Scoreboard([
    entry('3120', { gvc: setEntry('regression', 'labels-1') }, 0.4),
    entry('3130', {
      gvc: setEntry('regression', 'labels-1'),
      ecbplus: setEntry('training', 'labels-2'),
    }),
    entry('3140', { ecbplus: setEntry('training', 'labels-2') }, 0.6),
  ]);

  const reason = accepted.worse(
    'gvc',
    setEntry('regression', 'labels-1'),
    change(-0.02, -0.031, -0.004),
  );

  assert.match(
    reason ?? '',
    /gvc is a regression set, and the whole 95% interval of the change of its CoNLL F0\.5 against design 3130 is below 0/u,
  );
});

test('a regression set with a lower main score whose interval reaches 0 is not refused', () => {
  const accepted = new Scoreboard([
    entry('3130', { gvc: setEntry('regression', 'labels-1') }),
  ]);

  const reason = accepted.worse(
    'gvc',
    setEntry('regression', 'labels-1'),
    change(-0.006, -0.018, 0.004),
  );

  assert.equal(reason, null);
});

test('a regression set whose interval ends at exactly 0 is not refused', () => {
  const accepted = new Scoreboard([
    entry('3130', { gvc: setEntry('regression', 'labels-1') }),
  ]);

  const reason = accepted.worse(
    'gvc',
    setEntry('regression', 'labels-1'),
    change(-0.01, -0.02, 0),
  );

  assert.equal(reason, null);
});

test('a training set may score lower than the latest accepted design', () => {
  const accepted = new Scoreboard([
    entry('3130', { ecbplus: setEntry('training', 'labels-2') }),
  ]);

  const reason = accepted.worse(
    'ecbplus',
    setEntry('training', 'labels-2'),
    change(-0.2, -0.3, -0.1),
  );

  assert.equal(reason, null);
});

test('a regression score on fixed labels is not compared with a score on the old labels', () => {
  const accepted = new Scoreboard([
    entry('3130', { gvc: setEntry('regression', 'labels-1') }),
  ]);

  const reason = accepted.worse(
    'gvc',
    setEntry('regression', 'labels-fixed'),
    change(-0.2, -0.3, -0.1),
  );

  assert.equal(reason, null);
});

test('a design name that the scoreboard has is refused when its constants are others', () => {
  const accepted = new Scoreboard([
    entry('3130', { gvc: setEntry('regression', 'labels-1') }),
  ]);

  assert.throws(
    () =>
      accepted.with(
        entry('3130', { gvc: setEntry('regression', 'labels-1') }, 0.6),
      ),
    /Design 3130 is accepted already with other constants/u,
  );
});

test('a design name that the scoreboard has is refused with the same constants too, so one name has one entry', () => {
  const accepted = new Scoreboard([
    entry('3130', { gvc: setEntry('regression', 'labels-1') }),
  ]);

  assert.throws(
    () =>
      accepted.with(entry('3130', { gvc: setEntry('regression', 'labels-1') })),
    /Design 3130 is accepted already, with these constants/u,
  );
});

test('a new design name is accepted after the others, with its pin', () => {
  const accepted = new Scoreboard([
    entry('3130', { gvc: setEntry('regression', 'labels-1') }),
  ]);

  const next = accepted.with(
    entry('3152', { gvc: setEntry('regression', 'labels-1') }, 0.6),
  );

  assert.deepEqual(
    next.entries.map((candidate) => [
      candidate.design,
      candidate.pin.constants,
    ]),
    [
      ['3130', { THRESHOLD: 0.5, WINDOW_DAYS: 7 }],
      ['3152', { THRESHOLD: 0.6, WINDOW_DAYS: 7 }],
    ],
  );
});

test('the design that the package holds is the accepted entry with the same pin, and none when the constants changed', () => {
  const accepted = new Scoreboard([
    entry('3130', { gvc: setEntry('regression', 'labels-1') }),
    entry('3152', { gvc: setEntry('regression', 'labels-1') }, 0.6),
  ]);

  assert.equal(accepted.designOf(pin(0.5))?.design, '3130');
  assert.equal(accepted.designOf(pin(0.7)), null);
});

test('the change cannot be computed against a design whose scores are of another metric version', () => {
  const accepted = new Scoreboard([
    entry(
      '3130',
      { gvc: setEntry('regression', 'labels-1') },
      0.5,
      METRICS_VERSION - 1,
    ),
  ]);

  assert.throws(
    () => accepted.latest('gvc'),
    /Score design 3130 again with these metrics first/u,
  );
});

test('the package holds no accepted design when only the sha256 of src/frozen-design.ts differs, or only its constants', () => {
  const accepted = new Scoreboard([
    entry('3130', { gvc: setEntry('regression', 'labels-1') }),
  ]);

  // A comment changed: the constants are equal, the file is not.
  assert.equal(
    accepted.designOf({ ...pin(0.5), frozenDesignSha256: 'another-file' }),
    null,
  );
  assert.equal(
    accepted.designOf({
      ...pin(0.5),
      constants: { THRESHOLD: 0.6, WINDOW_DAYS: 7 },
    }),
    null,
  );
});
