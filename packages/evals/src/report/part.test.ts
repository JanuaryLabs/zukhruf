import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';
import { defaultRng } from '@zukhruf/random';
import { Linear, PercentileInterval } from '@zukhruf/statistics';

import { Bootstrap, Ratio, RunLog, type Sample } from '../index.ts';
import { measure } from './part.ts';

const info = { id: 'eval-1', label: 'model', createdAt: new Date(0) };

// One answered sample of a test, with a ratio for each name.
const sample = (
  testId: string,
  ratios: Record<string, Ratio>,
  { epoch = 0, weight = 1 } = {},
): Sample<string, null> => ({
  test: testId,
  epoch,
  weight,
  case: null,
  scorecard: { ratios: new Map(Object.entries(ratios)) },
  metadata: {},
  latencyMs: 0,
  call: { replayed: false, usage: undefined },
  outcome: 'answered',
  answer: 'an answer',
});

// A bootstrap whose generator counts its draws.
const counting = () => {
  const draws = { count: 0 };
  return {
    draws,
    bootstrap: new Bootstrap({
      nResamples: 3,
      randomIndex: () => {
        draws.count += 1;
        return 0;
      },
      interval: new PercentileInterval({
        low: 0,
        high: 1,
        method: new Linear(),
      }),
    }),
  };
};

const seeded = (seed: number) => {
  const generator = defaultRng(seed);
  return new Bootstrap({
    nResamples: 200,
    randomIndex: (n) => generator.integers(0, n, 1)[0] ?? Number.NaN,
    interval: new PercentileInterval({
      low: 0.025,
      high: 0.975,
      method: new Linear(),
    }),
  });
};

test('the value and the interval are Run#total and Bootstrap.interval on a run of the samples', () => {
  const samples = [
    sample('a', { recall: new Ratio(1, 1) }),
    sample('a', { recall: new Ratio(0, 3) }, { epoch: 1 }),
    sample('b', { recall: new Ratio(4, 5) }, { weight: 3 }),
    sample('c', { recall: new Ratio(1, 2) }),
  ];
  const log = new RunLog(info, [
    ...samples,
    sample('d', { recall: new Ratio(0, 9) }),
  ]);
  const run = new RunLog(info, samples).run();
  const expected = seeded(7).interval(run, 'recall');

  const numbers = measure(log, samples, 'recall', seeded(7));

  assert.deepEqual(numbers, {
    value: run.total('recall').value,
    ends: { low: expected?.low, high: expected?.high },
    interval: expected,
  });
});

void test.each(
  [
    {
      name: 'no sample gives the score',
      samples: [sample('a', { precision: new Ratio(1, 2) })],
    },
    { name: 'there are no samples', samples: [] },
    {
      name: 'the score has no whole',
      samples: [
        sample('a', { recall: new Ratio(0, 0) }),
        sample('b', { recall: new Ratio(0, 0) }),
      ],
    },
  ] satisfies { name: string; samples: Sample<string, null>[] }[],
  ({ name, samples }) =>
    test(`a score has no value and no interval, and the bootstrap draws nothing, when ${name}`, () => {
      const log = new RunLog(info, [
        ...samples,
        sample('z', { recall: new Ratio(1, 2) }),
      ]);
      const { draws, bootstrap } = counting();

      const numbers = measure(log, samples, 'recall', bootstrap);

      assert.deepEqual(
        { numbers, draws: draws.count },
        {
          numbers: {
            value: Number.NaN,
            ends: { low: Number.NaN, high: Number.NaN },
            interval: undefined,
          },
          draws: 0,
        },
      );
    }),
);

test('a score with a value draws from the bootstrap once for each resample of each test', () => {
  const samples = [
    sample('a', { recall: new Ratio(1, 2) }),
    sample('b', { recall: new Ratio(2, 2) }),
  ];
  const { draws, bootstrap } = counting();

  measure(new RunLog(info, samples), samples, 'recall', bootstrap);

  assert.equal(draws.count, 6);
});
