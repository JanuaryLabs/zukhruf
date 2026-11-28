import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Linear, PercentileInterval } from '@zukhruf/statistics';

import { Bootstrap, Ratio, RunLog, RunPair, type Sample } from '../index.ts';

const info = { id: 'eval-1', label: 'model', createdAt: new Date(0) };

test('the run of a log holds the ratio, the epoch and the weight of each sample, failed samples too', () => {
  const answered = (
    testId: string,
    epoch: number,
    ratio: Ratio,
    weight: number,
  ): Sample<string, null> => ({
    test: testId,
    epoch,
    weight,
    case: null,
    scorecard: { ratios: new Map([['recall', ratio]]) },
    metadata: {},
    latencyMs: 0,
    call: { replayed: false, usage: undefined },
    outcome: 'answered',
    answer: 'an answer',
  });
  const log = new RunLog(info, [
    answered('a', 0, new Ratio(1, 1), 1),
    answered('a', 1, new Ratio(0, 3), 1),
    answered('b', 0, new Ratio(1, 1), 3),
    {
      test: 'c',
      epoch: 0,
      weight: 1,
      case: null,
      // A failed call scores as a missing answer (ADR 0005): none of 1.
      scorecard: { ratios: new Map([['recall', new Ratio(0, 1)]]) },
      metadata: {},
      latencyMs: 0,
      call: { replayed: false, usage: undefined },
      outcome: 'failed',
      answer: null,
      error: 'timeout',
    },
  ]);
  const draws = [0, 1, 2];
  const bootstrap = new Bootstrap({
    nResamples: 1,
    randomIndex: () => draws.shift() ?? Number.NaN,
    interval: new PercentileInterval({ low: 0, high: 1, method: new Linear() }),
  });

  const interval = bootstrap.interval(log.run(), 'recall');

  // a is the mean of its two epochs, Ratio(0.5, 2), b counts 3 times,
  // Ratio(3, 3), and the failed c is Ratio(0, 1): 3.5 / 6. As four tests of
  // weight 1 it would be 2 / 6; without c, 3.5 / 5.
  assert.deepEqual(
    { low: interval?.low, high: interval?.high },
    { low: 3.5 / 6, high: 3.5 / 6 },
  );
});

test('a run log keeps its facts and each sample as given, a replay with the usage of its first call, in order, from an iterable that it reads once', () => {
  const samples: Sample<string, { readonly expected: string }>[] = [
    {
      test: 'a',
      epoch: 0,
      weight: 1,
      case: { expected: 'five credits' },
      scorecard: { ratios: new Map([['recall', new Ratio(1, 1)]]) },
      metadata: { labels: 4, split: 'tuning' },
      latencyMs: 6403,
      call: {
        replayed: false,
        usage: { input: 5567, output: 5309, cachedInput: 4021, cost: 0.002 },
      },
      outcome: 'answered',
      answer: 'five credits',
    },
    {
      test: 'b',
      epoch: 0,
      weight: 2,
      case: { expected: 'none' },
      scorecard: { ratios: new Map([['recall', new Ratio(0, 0)]]) },
      metadata: { labels: 3, split: 'tuning' },
      latencyMs: 12,
      // A replay keeps the usage of the call that first gave its answer.
      call: {
        replayed: true,
        usage: { input: 4021, output: 312, cachedInput: 0, cost: 0.001 },
      },
      outcome: 'answered',
      answer: 'none',
    },
  ];
  // A generator can be read only once.
  function* once() {
    yield* samples;
  }

  const log = new RunLog(info, once());

  assert.deepEqual(
    { info: log.info, samples: log.samples, again: log.samples },
    { info, samples, again: samples },
  );
});

test('epochs of one test with other weights are a RangeError when the log is built', () => {
  const epoch = (index: number, weight: number): Sample<string, null> => ({
    test: 'a',
    epoch: index,
    weight,
    case: null,
    scorecard: { ratios: new Map([['recall', new Ratio(1, 1)]]) },
    metadata: {},
    latencyMs: 0,
    call: { replayed: false, usage: undefined },
    outcome: 'answered',
    answer: 'an answer',
  });

  assert.throws(() => new RunLog(info, [epoch(0, 1), epoch(1, 2)]), {
    name: 'RangeError',
    message: 'Test "a" has the weight 1, not 2: the weight belongs to the case',
  });
});

test('two samples of one test and epoch are a RangeError that names them', () => {
  const sample: Sample<string, null> = {
    test: 'a',
    epoch: 0,
    weight: 1,
    case: null,
    scorecard: { ratios: new Map([['recall', new Ratio(1, 1)]]) },
    metadata: {},
    latencyMs: 0,
    call: { replayed: true, usage: undefined },
    outcome: 'answered',
    answer: 'an answer',
  };

  assert.throws(() => new RunLog(info, [sample, { ...sample }]), {
    name: 'RangeError',
    message:
      'A run log has one sample for each test and epoch. Twice: a (epoch 0)',
  });
});

test('a run pair refuses two logs whose tests differ, and names each test that one log does not have', () => {
  const log = (tests: readonly string[]) =>
    new RunLog(
      info,
      tests.map((testId): Sample<string, null> => ({
        test: testId,
        epoch: 0,
        weight: 1,
        case: null,
        scorecard: { ratios: new Map([['recall', new Ratio(1, 1)]]) },
        metadata: {},
        latencyMs: 0,
        call: { replayed: false, usage: undefined },
        outcome: 'answered',
        answer: 'an answer',
      })),
    );

  assert.throws(() => new RunPair(log(['a', 'b']), log(['b', 'c'])), {
    name: 'RangeError',
    message:
      'A run pair needs the same test ids in the baseline and the change. Not in both: a, c',
  });
});

test('a run pair refuses a test whose weight is not the same in the two logs', () => {
  const log = (weight: number) =>
    new RunLog(info, [
      {
        test: 'a',
        epoch: 0,
        weight,
        case: null,
        scorecard: { ratios: new Map([['recall', new Ratio(1, 1)]]) },
        metadata: {},
        latencyMs: 0,
        call: { replayed: false, usage: undefined },
        outcome: 'failed',
        answer: null,
        error: 'timeout',
      },
    ]);

  assert.throws(() => new RunPair(log(1), log(2)), {
    name: 'RangeError',
    message:
      'A test has the same weight in the baseline and the change. Other weights: a (1 and 2)',
  });
});

test('a run pair keeps its baseline and its change, in that order', () => {
  const log = (label: string) =>
    new RunLog({ ...info, label }, [
      {
        test: 'a',
        epoch: 0,
        weight: 1,
        case: null,
        scorecard: { ratios: new Map([['recall', new Ratio(1, 1)]]) },
        metadata: {},
        latencyMs: 0,
        call: { replayed: false, usage: undefined },
        outcome: 'answered',
        answer: 'an answer',
      },
    ]);
  const baseline = log('claude-haiku-5-5');
  const change = log('deepseek-v4.1-flash');

  const pair = new RunPair(baseline, change);

  assert.equal(pair.baseline, baseline);
  assert.equal(pair.change, change);
});

test('the types refuse a failed sample with an answer or with no error, and an answered sample with no answer', () => {
  const facts = {
    test: 'a',
    epoch: 0,
    weight: 1,
    case: null,
    scorecard: { ratios: new Map([['recall', new Ratio(1, 1)]]) },
    metadata: {},
    latencyMs: 0,
    call: { replayed: true, usage: undefined },
  } as const;
  // @ts-expect-error A failed call has no answer: its answer is null.
  const failed: Sample<string, null> = {
    ...facts,
    outcome: 'failed',
    answer: 'an answer',
    error: 'timeout',
  };
  // @ts-expect-error A failed sample holds its error.
  const silent: Sample<string, null> = {
    ...facts,
    outcome: 'failed',
    answer: null,
  };
  // @ts-expect-error An answered sample holds its answer.
  const answered: Sample<string, null> = { ...facts, outcome: 'answered' };

  // The values that the types refuse still build at run time; the claims of
  // this test are the three errors that the type checker must give.
  assert.equal([failed, silent, answered].length, 3);
});
