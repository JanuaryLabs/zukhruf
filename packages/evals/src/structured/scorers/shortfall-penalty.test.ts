import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ConfigCase,
  F1,
  ParseSuccess,
  PathMatches,
  SampleAveraged,
  ScorerSet,
  ShortfallPenalty,
} from '../index.ts';

test('ShortfallPenalty throws a RangeError for a target or a power that is 0, below 0 or NaN', () => {
  const keys = new SampleAveraged(new F1(new PathMatches()), { whenEmpty: 0 });

  const settings = [
    { target: 0, power: 2 },
    { target: -0.9, power: 2 },
    { target: Number.NaN, power: 2 },
    { target: 0.9, power: 0 },
    { target: 0.9, power: -2 },
    { target: 0.9, power: Number.NaN },
  ];

  for (const setting of settings)
    assert.throws(() => new ShortfallPenalty(keys, setting), RangeError);
});

test('ShortfallPenalty gives min(1, (value / target) ** power) with the bits of compute_coverage_gate of evaluate.py for image: 1 at the target and above it, 0 at 0, and the fraction to the power below it', () => {
  const keys = new SampleAveraged(new F1(new PathMatches()), { whenEmpty: 0 });
  const scorer = new ScorerSet({
    coverage: new ShortfallPenalty(keys, { target: 0.9, power: 2 }),
    atTarget: new ShortfallPenalty(keys, { target: 0.5, power: 2 }),
    cubed: new ShortfallPenalty(keys, { target: 0.9, power: 3 }),
  });
  const testCase = new ConfigCase().from({
    expected: { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
  });
  // The path F1 of each stated value: 1, 0, 0.5 (3 hits of 6 stated and 6
  // expected) and 0.6153846153846153 (4 hits of 7 stated).
  const stated = [
    { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 },
    { g: 7 },
    { a: 1, b: 2, c: 3, g: 7, h: 8, i: 9 },
    { a: 1, b: 2, c: 3, d: 4, g: 7, h: 8, i: 9 },
  ];

  const factors = stated.map((value) => {
    const scorecard = scorer.score(value, testCase);
    return ['coverage', 'atTarget', 'cubed'].map(
      (name) => scorecard.ratios.get(name)?.value,
    );
  });

  // CPython 3.12.9, evaluate.py da785a8: compute_coverage_gate('image', x)
  // for 0.5 and 0.6153846153846153, and min(1.0, (x / 0.9) ** 3).
  assert.deepEqual(factors, [
    [1, 1, 1],
    [0, 0, 0],
    [0.308641975308642, 1, 0.1714677640603567],
    [0.46752867265687764, 1, 0.31967772489359153],
  ]);
});

test('a ShortfallPenalty in a ScorerSet gives its factor over 1 and no check, so a record with a factor of 0 still passes; a gate stays a check', () => {
  const keys = new SampleAveraged(new F1(new PathMatches()), { whenEmpty: 0 });
  const scorer = new ScorerSet({
    coverage: new ShortfallPenalty(keys, { target: 0.9, power: 2 }),
    parsed: new ParseSuccess(),
  });

  const scorecard = scorer.score(
    { g: 7 },
    new ConfigCase().from({ expected: { a: 1 } }),
  );

  const ratio = scorecard.ratios.get('coverage');
  assert.deepEqual(
    [
      ratio?.part,
      ratio?.whole,
      scorecard.passed,
      scorecard.checks.map((check) => check.name),
    ],
    [0, 1, true, ['parsed']],
  );
});
