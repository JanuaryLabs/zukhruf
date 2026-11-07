import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { type Scores, scores } from './metrics.ts';

// fixtures/metric-row/expected.json holds what metric_row of the research
// oracle (round-2 evaluate.py, numpy 2.3.4) gave for each stream: generate.py
// makes it. A float NaN is the string "NaN".
type Stream = {
  readonly stream: string;
  readonly accepted: readonly boolean[];
  readonly probabilities: readonly number[];
  readonly relevant: readonly boolean[];
  readonly metric_row: Readonly<Record<keyof Scores, number | 'NaN'>>;
};

const { streams }: { readonly streams: readonly Stream[] } = JSON.parse(
  readFileSync(
    join(import.meta.dirname, 'fixtures/metric-row/expected.json'),
    'utf8',
  ),
);

test('the scores of a run are those of the research metric_row', () => {
  const result = scores(
    [true, true, false, false],
    [0.9, 0.6, 0.2, 0.1],
    [true, false, true, false],
  );

  // tp 1, fp 1, fn 1; Brier (0.01 + 0.36 + 0.64 + 0.01) / 4; base rate 0.5.
  assert.equal(result.f05, 1.25 / 2.5);
  assert.equal(result.brier, 0.25500000000000006);
  assert.equal(result.brierSkill, -0.02000000000000024);
  assert.deepEqual(
    [result.tp, result.fp, result.fn, result.accepted],
    [1, 1, 1, 2],
  );
});

test('a stream with no relevant article has no Brier skill', () => {
  assert.ok(Number.isNaN(scores([false], [0.1], [false]).brierSkill));
});

for (const stream of streams)
  test(`the scores of ${stream.stream} are the bits of the research metric_row`, () => {
    const result = scores(
      stream.accepted,
      stream.probabilities,
      stream.relevant,
    );

    assert.deepEqual(
      result,
      Object.fromEntries(
        Object.entries(stream.metric_row).map(([key, value]) => [
          key,
          value === 'NaN' ? Number.NaN : value,
        ]),
      ),
    );
  });
