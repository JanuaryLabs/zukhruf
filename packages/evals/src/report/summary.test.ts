import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';
import { defaultRng } from '@zukhruf/random';
import { Linear, PercentileInterval } from '@zukhruf/statistics';

import {
  Bars,
  Bootstrap,
  Ratio,
  RunLog,
  type Sample,
  Table,
} from '../index.ts';
import {
  HtmlRenderer,
  MarkdownRenderer,
  Page,
  type Score,
  type Slice,
  Summary,
} from './index.ts';

const info = { id: 'eval-1', label: 'model', createdAt: new Date(0) };

// One answered sample of a test, with a ratio for each name, on a page of
// the kind it names.
const sample = (
  testId: string,
  ratios: Record<string, Ratio>,
  { epoch = 0, weight = 1, page = 'offers' } = {},
): Sample<string, null> => ({
  test: testId,
  epoch,
  weight,
  case: null,
  scorecard: { ratios: new Map(Object.entries(ratios)) },
  metadata: { page },
  latencyMs: 0,
  call: { replayed: false, usage: undefined },
  outcome: 'answered',
  answer: 'an answer',
});

const pages: Slice<string, null>[] = [
  { name: 'page', key: (sample) => String(sample.metadata.page) },
];

// A bootstrap whose interval is the lowest and the highest statistic of its
// resamples, drawn in the order of the draws, again and again.
const scripted = (nResamples: number, draws: readonly number[]) => {
  let index = 0;
  return new Bootstrap({
    nResamples,
    randomIndex: () => draws[index++ % draws.length] ?? Number.NaN,
    interval: new PercentileInterval({ low: 0, high: 1, method: new Linear() }),
  });
};

// Two tests that give each name 9 of 10 and 7 of 10: the value is 0.8, and
// two resamples of [a, a] and [b, b] give the interval [0.7, 0.9].
const twoTests = (...names: string[]) =>
  new RunLog(info, [
    sample(
      'a',
      Object.fromEntries(names.map((name) => [name, new Ratio(9, 10)])),
    ),
    sample(
      'b',
      Object.fromEntries(names.map((name) => [name, new Ratio(7, 10)])),
    ),
  ]);

const parts = (summary: Summary<string, null>) => {
  const [table, bars] = summary.primitives;
  assert.ok(table instanceof Table && bars instanceof Bars);
  return { table, bars };
};

test('the value and the interval of each score are Run#total and Bootstrap.interval on the same run', () => {
  const log = new RunLog(info, [
    sample('a', { recall: new Ratio(1, 1), precision: new Ratio(2, 3) }),
    sample(
      'a',
      { recall: new Ratio(0, 3), precision: new Ratio(1, 1) },
      { epoch: 1 },
    ),
    sample(
      'b',
      { recall: new Ratio(4, 5), precision: new Ratio(0, 2) },
      { weight: 3 },
    ),
    sample('c', { recall: new Ratio(1, 2), precision: new Ratio(5, 5) }),
  ]);
  const bootstrap = (seed: number) => {
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
  const expected = bootstrap(7);
  const run = log.run();
  const numbers = (name: string) => {
    const interval = expected.interval(run, name);
    return {
      value: run.total(name).value,
      ends: { low: interval.low, high: interval.high },
    };
  };
  const recall = numbers('recall');
  const precision = numbers('precision');

  const { bars } = parts(
    new Summary(log, {
      scores: [
        { name: 'recall', higherIsBetter: true },
        { name: 'precision', higherIsBetter: true },
      ],
      slices: [],
      bootstrap: bootstrap(7),
    }),
  );

  assert.deepEqual(
    bars.bars.map(({ label, value, ends }) => ({ label, value, ends })),
    [
      { label: 'recall', ...recall },
      { label: 'precision', ...precision },
    ],
  );
});

test('the interval column names the level of the interval method of the bootstrap', () => {
  const { table } = parts(
    new Summary(twoTests('recall'), {
      scores: [{ name: 'recall', higherIsBetter: true }],
      slices: [],
      bootstrap: new Bootstrap({
        nResamples: 2,
        randomIndex: () => 0,
        interval: new PercentileInterval({
          low: 0.025,
          high: 0.975,
          method: new Linear(),
        }),
      }),
    }),
  );

  assert.deepEqual(table.columns, [
    'score',
    'value',
    '95% interval',
    'bar',
    'verdict',
  ]);
});

void test.each(
  [
    {
      name: 'an interval above an at-least bar meets it',
      score: {
        name: 'values_recall',
        higherIsBetter: true,
        bar: { atLeast: 0.6 },
      },
      row: ['values_recall', '0.800', '[0.700, 0.900]', '≥ 0.6', 'met'],
      tone: 'good',
      claim: 'values_recall meets its bar',
    },
    {
      name: 'an interval below an at-least bar misses it',
      score: {
        name: 'values_recall',
        higherIsBetter: true,
        bar: { atLeast: 0.95 },
      },
      row: ['values_recall', '0.800', '[0.700, 0.900]', '≥ 0.95', 'missed'],
      tone: 'bad',
      claim: 'values_recall misses its bar of 0.95: 0.800 [0.700, 0.900]',
    },
    {
      name: 'an interval that holds an at-least bar leaves it open',
      score: {
        name: 'values_recall',
        higherIsBetter: true,
        bar: { atLeast: 0.8 },
      },
      row: ['values_recall', '0.800', '[0.700, 0.900]', '≥ 0.8', 'open'],
      tone: 'neutral',
      claim:
        'values_recall is within chance of its bar of 0.8: 0.800 [0.700, 0.900]',
    },
    {
      name: 'an interval below an at-most bar meets it',
      score: { name: 'cost', higherIsBetter: false, bar: { atMost: 0.95 } },
      row: ['cost', '0.800', '[0.700, 0.900]', '≤ 0.95', 'met'],
      tone: 'good',
      claim: 'cost meets its bar',
    },
    {
      name: 'an interval above an at-most bar misses it',
      score: { name: 'cost', higherIsBetter: false, bar: { atMost: 0.6 } },
      row: ['cost', '0.800', '[0.700, 0.900]', '≤ 0.6', 'missed'],
      tone: 'bad',
      claim: 'cost misses its bar of 0.6: 0.800 [0.700, 0.900]',
    },
    {
      name: 'an interval that holds an at-most bar leaves it open',
      score: { name: 'cost', higherIsBetter: false, bar: { atMost: 0.7 } },
      row: ['cost', '0.800', '[0.700, 0.900]', '≤ 0.7', 'open'],
      tone: 'neutral',
      claim: 'cost is within chance of its bar of 0.7: 0.800 [0.700, 0.900]',
    },
  ] satisfies {
    name: string;
    score: Score;
    row: string[];
    tone: string;
    claim: string;
  }[],
  ({ name, score, row, tone, claim }) =>
    test(name, () => {
      const summary = new Summary(twoTests(score.name), {
        scores: [score],
        slices: [],
        bootstrap: scripted(2, [0, 0, 1, 1]),
      });

      const { table, bars } = parts(summary);

      assert.deepEqual(
        {
          claim: summary.claim,
          columns: table.columns,
          rows: table.rows.map((cells) => cells.map(({ text }) => text)),
          verdict: table.rows[0]?.[4]?.tone,
          bar: bars.bars[0]?.tone,
        },
        {
          claim,
          columns: ['score', 'value', '100% interval', 'bar', 'verdict'],
          rows: [row],
          verdict: tone,
          bar: tone,
        },
      );
    }),
);

test('a bar on a slice is read on a row of the samples of its key only, below the row of the whole run', () => {
  const log = new RunLog(info, [
    sample('a', { values_recall: new Ratio(9, 10) }),
    sample('b', { values_recall: new Ratio(1, 10) }, { page: 'empty' }),
    sample('c', { values_recall: new Ratio(7, 10) }),
  ]);

  const summary = new Summary(log, {
    scores: [
      {
        name: 'values_recall',
        higherIsBetter: true,
        bar: { atLeast: 0.6, slice: ['page', 'offers'] },
      },
    ],
    slices: pages,
    // The whole run draws a, b and c; the slice draws a and c.
    bootstrap: scripted(1, [0, 1, 2, 0, 1]),
  });

  const { table } = parts(summary);
  // The whole run is 17 / 30; the pages with offers, a and c, 16 / 20. With
  // b, the slice would be 17 / 30 too.
  assert.deepEqual(
    {
      claim: summary.claim,
      rows: table.rows.map((cells) => cells.map(({ text }) => text)),
    },
    {
      claim: 'values_recall · page = offers meets its bar',
      rows: [
        ['values_recall', '0.567', '[0.567, 0.567]', '', ''],
        [
          'values_recall · page = offers',
          '0.800',
          '[0.800, 0.800]',
          '≥ 0.6',
          'met',
        ],
      ],
    },
  );
});

void test.each(
  [
    {
      name: 'every bar met names each score',
      bars: [0.6, 0.6, 0.6],
      claim: 'values_recall, values_precision, and values_f1 meet their bars',
    },
    {
      name: 'a missed bar comes before an open bar and a met bar',
      bars: [0.6, 0.8, 0.95],
      claim: 'values_f1 misses its bar of 0.95: 0.800 [0.700, 0.900]',
    },
    {
      name: 'each missed bar is named with its value, its interval and its bar',
      bars: [0.95, 0.6, 0.92],
      claim:
        'values_recall misses its bar of 0.95: 0.800 [0.700, 0.900]; values_f1 misses its bar of 0.92: 0.800 [0.700, 0.900]',
    },
    {
      name: 'an open bar comes before a met bar',
      bars: [0.6, 0.8, 0.6],
      claim:
        'values_precision is within chance of its bar of 0.8: 0.800 [0.700, 0.900]',
    },
    {
      name: 'with no bars, each score with its value and interval over the tests',
      bars: [undefined, undefined, undefined],
      claim:
        'values_recall 0.800 [0.700, 0.900]; values_precision 0.800 [0.700, 0.900]; values_f1 0.800 [0.700, 0.900] over 2 tests',
    },
  ],
  ({ name, bars, claim }) =>
    test(`the claim: ${name}`, () => {
      const names = ['values_recall', 'values_precision', 'values_f1'];
      const scores = names.map((score, index): Score => {
        const atLeast = bars[index];
        return atLeast === undefined
          ? { name: score, higherIsBetter: true }
          : { name: score, higherIsBetter: true, bar: { atLeast } };
      });

      const summary = new Summary(twoTests(...names), {
        scores,
        slices: [],
        bootstrap: scripted(2, [0, 0, 1, 1]),
      });

      assert.equal(summary.claim, claim);
    }),
);

test('a bar on a slice that the slices do not have is a RangeError that names the slices', () => {
  assert.throws(
    () =>
      new Summary(twoTests('values_precision'), {
        scores: [
          {
            name: 'values_precision',
            higherIsBetter: true,
            bar: { atLeast: 0.88, slice: ['pages', 'offers'] },
          },
        ],
        slices: pages,
        bootstrap: scripted(2, [0, 0, 1, 1]),
      }),
    {
      name: 'RangeError',
      message:
        'The bar of values_precision reads the slice "pages", and the slices are: page',
    },
  );
});

test('a slice with no samples has no value and no interval, and its bar is untested', () => {
  const summary = new Summary(twoTests('values_f1'), {
    scores: [
      {
        name: 'values_f1',
        higherIsBetter: true,
        bar: { atLeast: 0.95, slice: ['page', 'empty'] },
      },
    ],
    slices: pages,
    bootstrap: scripted(2, [0, 0, 1, 1]),
  });

  const { table, bars } = parts(summary);
  assert.deepEqual(
    {
      claim: summary.claim,
      row: table.rows[1]?.map(({ text, tone }) => ({ text, tone })),
      bar: bars.bars[1],
    },
    {
      claim: 'values_f1 · page = empty has no value for its bar of 0.95',
      row: [
        { text: 'values_f1 · page = empty', tone: 'neutral' },
        { text: '—', tone: 'neutral' },
        { text: '[—, —]', tone: 'neutral' },
        { text: '≥ 0.95', tone: 'neutral' },
        { text: 'untested', tone: 'neutral' },
      ],
      bar: {
        label: 'values_f1 · page = empty',
        value: Number.NaN,
        ends: { low: Number.NaN, high: Number.NaN },
        tone: 'neutral',
      },
    },
  );
});

test('the bars have one mark for each bar value, which the scores with that bar share', () => {
  const log = new RunLog(info, [
    sample('a', {
      values_recall: new Ratio(9, 10),
      values_precision: new Ratio(9, 10),
      values_f1: new Ratio(9, 10),
    }),
    sample(
      'b',
      {
        values_recall: new Ratio(7, 10),
        values_precision: new Ratio(7, 10),
        values_f1: new Ratio(1, 1),
      },
      { page: 'empty' },
    ),
  ]);

  const { bars } = parts(
    new Summary(log, {
      scores: [
        { name: 'values_recall', higherIsBetter: true, bar: { atLeast: 0.88 } },
        {
          name: 'values_precision',
          higherIsBetter: true,
          bar: { atLeast: 0.88, slice: ['page', 'offers'] },
        },
        {
          name: 'values_f1',
          higherIsBetter: true,
          bar: { atLeast: 0.95, slice: ['page', 'empty'] },
        },
      ],
      slices: pages,
      bootstrap: scripted(1, [0]),
    }),
  );

  assert.deepEqual(
    { scale: bars.scale, marks: bars.marks },
    {
      scale: { low: 0, high: 1 },
      marks: [
        { label: 'bar', at: 0.88 },
        { label: 'bar', at: 0.95 },
      ],
    },
  );
});

test('a summary with no bars counts each test once in its claim, whatever the epochs of the test', () => {
  const log = new RunLog(info, [
    sample('a', { values_recall: new Ratio(9, 10) }, { epoch: 0 }),
    sample('a', { values_recall: new Ratio(7, 10) }, { epoch: 1 }),
    sample('b', { values_recall: new Ratio(8, 10) }),
  ]);

  const summary = new Summary(log, {
    scores: [{ name: 'values_recall', higherIsBetter: true }],
    slices: [],
    bootstrap: scripted(1, [0]),
  });

  assert.match(summary.claim, / over 2 tests$/);
});

test('a score past 1, such as a mean count, widens the scale of the bars to hold its value and its interval', () => {
  // 30 of 10 and 12 of 10: the value is 42 of 20, and the resamples [a, a]
  // and [b, b] give the interval [1.2, 3].
  const log = new RunLog(info, [
    sample('a', { offers_per_page: new Ratio(30, 10) }),
    sample('b', { offers_per_page: new Ratio(12, 10) }),
  ]);

  const { bars } = parts(
    new Summary(log, {
      scores: [{ name: 'offers_per_page', higherIsBetter: true }],
      slices: [],
      bootstrap: scripted(2, [0, 0, 1, 1]),
    }),
  );

  assert.deepEqual(bars.scale, { low: 0, high: 3 });
});

test('a score with no whole, such as recall on pages with no expected value, has no value, and its bar is untested', () => {
  const log = new RunLog(info, [
    sample('a', { values_recall: new Ratio(0, 0) }, { page: 'empty' }),
    sample('b', { values_recall: new Ratio(0, 0) }, { page: 'empty' }),
  ]);

  const summary = new Summary(log, {
    scores: [
      { name: 'values_recall', higherIsBetter: true, bar: { atLeast: 0.88 } },
    ],
    slices: pages,
    bootstrap: scripted(1, [0]),
  });

  assert.equal(summary.claim, 'values_recall has no value for its bar of 0.88');
  assert.deepEqual(
    parts(summary).table.rows.map((cells) => cells.map(({ text }) => text)),
    [['values_recall', '—', '[—, —]', '≥ 0.88', 'untested']],
  );
});

test('a bar on a slice where no sample gives the score is untested, not an error', () => {
  const log = new RunLog(info, [
    sample('a', { values_precision: new Ratio(9, 10) }, { page: 'offers' }),
    sample('b', { values_f1: new Ratio(1, 1) }, { page: 'empty' }),
  ]);

  const summary = new Summary(log, {
    scores: [
      {
        name: 'values_precision',
        higherIsBetter: true,
        bar: { atLeast: 0.88, slice: ['page', 'empty'] },
      },
    ],
    slices: pages,
    bootstrap: scripted(1, [0]),
  });

  assert.equal(
    summary.claim,
    'values_precision · page = empty has no value for its bar of 0.88',
  );
});

test('a score that no sample of the run gives is an error, not a row of dashes', () => {
  assert.throws(
    () =>
      new Summary(twoTests('values_recall'), {
        scores: [{ name: 'values_recal', higherIsBetter: true }],
        slices: [],
        bootstrap: scripted(1, [0]),
      }),
    {
      name: 'Error',
      message: 'No scorecard of the run gave a ratio named "values_recal"',
    },
  );
});

test('a summary of one test with no bars says one test', () => {
  const log = new RunLog(info, [
    sample('a', { values_recall: new Ratio(9, 10) }),
  ]);

  const summary = new Summary(log, {
    scores: [{ name: 'values_recall', higherIsBetter: true }],
    slices: [],
    bootstrap: scripted(1, [0]),
  });

  assert.match(summary.claim, / over 1 test$/);
});

test('a summary with an untested slice renders as HTML and Markdown with its claim and with no NaN', () => {
  const summary = new Summary(twoTests('values_f1'), {
    scores: [
      {
        name: 'values_f1',
        higherIsBetter: true,
        bar: { atLeast: 0.95, slice: ['page', 'empty'] },
      },
    ],
    slices: pages,
    bootstrap: scripted(2, [0, 0, 1, 1]),
  });
  const page = new Page('offers', [summary]);

  const html = new HtmlRenderer().render(page);
  const markdown = new MarkdownRenderer().render(page);

  assert.deepEqual(
    {
      html: { claim: html.includes(summary.claim), nan: html.includes('NaN') },
      markdown: {
        claim: markdown.includes(summary.claim),
        nan: markdown.includes('NaN'),
      },
    },
    {
      html: { claim: true, nan: false },
      markdown: { claim: true, nan: false },
    },
  );
});
