import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';
import { defaultRng } from '@zukhruf/random';
import { Linear, PercentileInterval } from '@zukhruf/statistics';

import {
  Bootstrap,
  Line,
  Ratio,
  RunLog,
  type Sample,
  Table,
} from '../index.ts';
import { render } from '../testing/render.ts';
import { type Score, Trend } from './index.ts';
import { measure } from './part.ts';

// One answered sample of a test, with a ratio for each name.
const sample = (
  testId: string,
  ratios: Record<string, Ratio>,
): Sample<string, null> => ({
  test: testId,
  epoch: 0,
  weight: 1,
  case: null,
  scorecard: { ratios: new Map(Object.entries(ratios)) },
  metadata: {},
  latencyMs: 0,
  call: { replayed: false, usage: undefined },
  outcome: 'answered',
  answer: 'an answer',
});

// A run of the id, created on the day, with the samples.
const log = (id: string, day: string, samples: Sample<string, null>[]) =>
  new RunLog(
    { id, label: `model of ${id}`, createdAt: new Date(`${day}T12:00:00Z`) },
    samples,
  );

// A run of one test a that gives each name its ratio: every resample is [a],
// so the interval of a value v is [v, v].
const single = (id: string, day: string, ratios: Record<string, Ratio>) =>
  log(id, day, [sample('a', ratios)]);

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

const first = () =>
  new Bootstrap({
    nResamples: 10,
    randomIndex: () => 0,
    interval: new PercentileInterval({ low: 0, high: 1, method: new Linear() }),
  });

const higher = (name: string): Score => ({ name, higherIsBetter: true });

const parts = (trend: Trend<string, null>) => {
  const [line, table] = trend.primitives;
  assert.ok(line instanceof Line && table instanceof Table);
  return {
    line,
    rows: table.rows.map((cells) => cells.map(({ text }) => text)),
    columns: table.columns,
  };
};

test('each point is measure of its score on its run, drawn run by run and score by score', () => {
  const runs = [
    log('eval-1', '2026-11-01', [
      sample('a', { recall: new Ratio(1, 1), precision: new Ratio(2, 3) }),
      sample('b', { recall: new Ratio(4, 5), precision: new Ratio(0, 2) }),
      sample('c', { recall: new Ratio(1, 2), precision: new Ratio(5, 5) }),
    ]),
    log('eval-2', '2026-11-02', [
      sample('a', { recall: new Ratio(0, 3), precision: new Ratio(1, 1) }),
      sample('b', { recall: new Ratio(3, 5), precision: new Ratio(2, 2) }),
      sample('c', { recall: new Ratio(2, 2), precision: new Ratio(1, 5) }),
    ]),
  ] as const;
  const expected = seeded(7);
  const points = runs.map((run) =>
    ['recall', 'precision'].map((name) => {
      const { value, ends } = measure(run, run.samples, name, expected);
      return { value, ends };
    }),
  );

  const { line } = parts(
    new Trend(runs, {
      scores: [higher('recall'), higher('precision')],
      bootstrap: seeded(7),
    }),
  );

  assert.deepEqual(line.series, [
    { label: 'recall', values: points.map(([recall]) => recall) },
    { label: 'precision', values: points.map(([, precision]) => precision) },
  ]);
});

test('the runs keep the order the caller gives, even when their creation times run the other way, and each step is the id of its run', () => {
  const runs = [
    single('eval-c', '2026-11-03', { f1: new Ratio(3, 4) }),
    single('eval-b', '2026-11-02', { f1: new Ratio(2, 4) }),
    single('eval-a', '2026-11-01', { f1: new Ratio(1, 4) }),
  ] as const;

  const trend = new Trend(runs, { scores: [higher('f1')], bootstrap: first() });
  const { line, rows } = parts(trend);

  assert.deepEqual(
    {
      steps: line.steps,
      values: line.series.map(({ values }) => values.map(({ value }) => value)),
      rows: rows.map(([run]) => run),
      claim: trend.claim,
    },
    {
      steps: ['eval-c', 'eval-b', 'eval-a'],
      values: [[0.75, 0.5, 0.25]],
      rows: ['eval-c', 'eval-b', 'eval-a'],
      claim:
        'f1 went from 0.750 [0.750, 0.750] on eval-c to 0.250 [0.250, 0.250] on eval-a over 3 runs',
    },
  );
});

test('the tests of a run are its distinct tests, and a test that only some runs have counts in each run that has it', () => {
  const runs = [
    log('eval-1', '2026-11-01', [
      sample('a', { f1: new Ratio(1, 1) }),
      { ...sample('a', { f1: new Ratio(0, 1) }), epoch: 1 },
      sample('b', { f1: new Ratio(1, 1) }),
    ]),
    log('eval-2', '2026-11-02', [
      sample('a', { f1: new Ratio(1, 1) }),
      sample('b', { f1: new Ratio(1, 1) }),
      sample('c', { f1: new Ratio(1, 1) }),
    ]),
  ] as const;

  const { columns, rows } = parts(
    new Trend(runs, { scores: [higher('f1')], bootstrap: first() }),
  );

  assert.deepEqual(
    { column: columns[2], tests: rows.map(([, , tests]) => tests) },
    { column: 'tests', tests: ['2', '3'] },
  );
});

test('a Trend of one run cannot be written', () => {
  const runs = [single('eval-1', '2026-11-01', { f1: new Ratio(1, 2) })];

  const trend = new Trend(
    // @ts-expect-error A trend needs two runs or more.
    runs,
    { scores: [higher('f1')], bootstrap: first() },
  );

  // The section still builds at run time; the claim is the type error.
  assert.equal(trend.id, 'trend');
});

test('the table gives each run its id, the day it was created and each score with its interval', () => {
  const runs = [
    single('eval-1', '2026-11-01', {
      recall: new Ratio(1, 2),
      precision: new Ratio(1, 4),
    }),
    single('eval-2', '2026-11-27', {
      recall: new Ratio(3, 4),
      precision: new Ratio(1, 1),
    }),
  ] as const;

  const { columns, rows } = parts(
    new Trend(runs, {
      scores: [higher('recall'), higher('precision')],
      bootstrap: first(),
    }),
  );

  assert.deepEqual(
    { columns, rows },
    {
      columns: ['run', 'created', 'tests', 'recall', 'precision'],
      rows: [
        [
          'eval-1',
          '2026-11-01',
          '1',
          '0.500 [0.500, 0.500]',
          '0.250 [0.250, 0.250]',
        ],
        [
          'eval-2',
          '2026-11-27',
          '1',
          '0.750 [0.750, 0.750]',
          '1.000 [1.000, 1.000]',
        ],
      ],
    },
  );
});

test('a run where a score has no whole is a gap in its line and a dash in the table', () => {
  const runs = [
    single('eval-1', '2026-11-01', { f1: new Ratio(1, 2) }),
    single('eval-2', '2026-11-02', { f1: new Ratio(0, 0) }),
    single('eval-3', '2026-11-03', { f1: new Ratio(1, 1) }),
  ] as const;

  const { line, rows } = parts(
    new Trend(runs, { scores: [higher('f1')], bootstrap: first() }),
  );

  assert.deepEqual(
    {
      gap: line.series.map(({ values }) =>
        values.map(({ value }) => Number.isNaN(value)),
      ),
      cells: rows.map(([, , , f1]) => f1),
    },
    {
      gap: [[false, true, false]],
      cells: ['0.500 [0.500, 0.500]', '—', '1.000 [1.000, 1.000]'],
    },
  );
});

void test.each(
  [
    {
      name: 'no run has a value of the first score',
      runs: [
        single('eval-1', '2026-11-01', { f1: new Ratio(0, 0) }),
        single('eval-2', '2026-11-02', { f1: new Ratio(0, 0) }),
      ],
      claim: 'f1 has no value on any of the 2 runs',
    },
    {
      name: 'only one run has a value of the first score',
      runs: [
        single('eval-1', '2026-11-01', { f1: new Ratio(0, 0) }),
        single('eval-2', '2026-11-02', { f1: new Ratio(1, 2) }),
        single('eval-3', '2026-11-03', { f1: new Ratio(0, 0) }),
      ],
      claim: 'f1 has a value on one run only, eval-2: 0.500 [0.500, 0.500]',
    },
    {
      name: 'the first score has a value on many runs',
      runs: [
        single('eval-3', '2026-11-03', { f1: new Ratio(0, 0) }),
        single('eval-2', '2026-11-02', { f1: new Ratio(3, 4) }),
        single('eval-1', '2026-11-01', { f1: new Ratio(1, 4) }),
        single('eval-0', '2026-10-31', { f1: new Ratio(0, 0) }),
      ],
      claim:
        'f1 went from 0.750 [0.750, 0.750] on eval-2 to 0.250 [0.250, 0.250] on eval-1 over 4 runs',
    },
  ] satisfies {
    name: string;
    runs: readonly [
      RunLog<string, null>,
      RunLog<string, null>,
      ...RunLog<string, null>[],
    ];
    claim: string;
  }[],
  ({ name, runs, claim }) =>
    test(`the claim when ${name}`, () => {
      const trend = new Trend(runs, {
        scores: [higher('f1')],
        bootstrap: first(),
      });

      assert.equal(trend.claim, claim);
    }),
);

test('the claim reads the first score only', () => {
  const runs = [
    single('eval-1', '2026-11-01', {
      f1: new Ratio(1, 2),
      recall: new Ratio(0, 1),
    }),
    single('eval-2', '2026-11-02', {
      f1: new Ratio(1, 2),
      recall: new Ratio(1, 1),
    }),
  ] as const;

  const trend = new Trend(runs, {
    scores: [higher('f1'), higher('recall')],
    bootstrap: first(),
  });

  assert.equal(
    trend.claim,
    'f1 went from 0.500 [0.500, 0.500] on eval-1 to 0.500 [0.500, 0.500] on eval-2 over 2 runs',
  );
});

test('a Trend of no scores is a RangeError', () => {
  const runs = [
    single('eval-1', '2026-11-01', { f1: new Ratio(1, 2) }),
    single('eval-2', '2026-11-02', { f1: new Ratio(1, 2) }),
  ] as const;

  assert.throws(() => new Trend(runs, { scores: [], bootstrap: first() }), {
    name: 'RangeError',
    message: 'A Trend section needs a score to show',
  });
});

test('a score that no sample of one of the runs gives is an error, not a gap', () => {
  const runs = [
    single('eval-1', '2026-11-01', { f1: new Ratio(1, 2) }),
    single('eval-2', '2026-11-02', { recall: new Ratio(1, 2) }),
  ] as const;

  assert.throws(
    () => new Trend(runs, { scores: [higher('f1')], bootstrap: first() }),
    {
      name: 'Error',
      message: 'No scorecard of the run gave a ratio named "f1"',
    },
  );
});

test('a Trend section with a gap renders as HTML and Markdown with its claim and with no NaN', () => {
  const section = new Trend(
    [
      single('eval-1', '2026-11-01', { f1: new Ratio(1, 4) }),
      single('eval-2', '2026-11-02', { f1: new Ratio(0, 0) }),
      single('eval-3', '2026-11-03', { f1: new Ratio(3, 4) }),
    ],
    { scores: [higher('f1')], bootstrap: first() },
  );
  const { html, markdown, heading } = render(section);

  assert.deepEqual(
    {
      html: { claim: html.includes(section.claim), nan: html.includes('NaN') },
      markdown: { heading, nan: markdown.includes('NaN') },
    },
    {
      html: { claim: true, nan: false },
      markdown: {
        heading:
          'f1 went from 0.250 [0.250, 0.250] on eval-1 to 0.750 [0.750, 0.750] on eval-3 over 3 runs',
        nan: false,
      },
    },
  );
});
