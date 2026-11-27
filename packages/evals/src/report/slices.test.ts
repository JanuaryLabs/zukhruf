import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';
import { defaultRng } from '@zukhruf/random';
import { Linear, PercentileInterval } from '@zukhruf/statistics';

import { Bootstrap, Ratio, RunLog, type Sample, Table } from '../index.ts';
import {
  HtmlRenderer,
  MarkdownRenderer,
  Page,
  type Score,
  type Slice,
  Slices,
} from './index.ts';

const info = { id: 'eval-1', label: 'model', createdAt: new Date(0) };

// One answered sample of a test, with a ratio for each name, on a page of
// the kind and the length it names.
const sample = (
  testId: string,
  ratios: Record<string, Ratio>,
  { epoch = 0, page = 'offers', length = '1' } = {},
): Sample<string, null> => ({
  test: testId,
  epoch,
  weight: 1,
  case: null,
  scorecard: { ratios: new Map(Object.entries(ratios)) },
  metadata: { page, length },
  latencyMs: 0,
  call: { replayed: false, usage: undefined },
  outcome: 'answered',
  answer: 'an answer',
});

const page: Slice<string, null> = {
  name: 'page',
  key: (sample) => String(sample.metadata.page),
};
const length: Slice<string, null> = {
  name: 'length',
  key: (sample) => String(sample.metadata.length),
};

// A bootstrap of one resample that draws the first test: on a key of one
// test, the interval is the value of that test.
const firstTest = () =>
  new Bootstrap({
    nResamples: 1,
    randomIndex: () => 0,
    interval: new PercentileInterval({ low: 0, high: 1, method: new Linear() }),
  });

const tables = (slices: Slices<string, null>) =>
  slices.primitives.map((primitive) => {
    assert.ok(primitive instanceof Table);
    return {
      columns: primitive.columns,
      rows: primitive.rows.map((cells) => cells.map(({ text }) => text)),
    };
  });

test('each score cell is Run#total and Bootstrap.interval on the samples of its key', () => {
  const log = new RunLog(info, [
    sample('a', { recall: new Ratio(9, 10), precision: new Ratio(2, 3) }),
    sample(
      'b',
      { recall: new Ratio(1, 4), precision: new Ratio(1, 1) },
      {
        page: 'empty',
      },
    ),
    sample('c', { recall: new Ratio(3, 5), precision: new Ratio(0, 2) }),
    sample('d', { recall: new Ratio(4, 4), precision: new Ratio(3, 4) }),
    sample(
      'e',
      { recall: new Ratio(0, 2), precision: new Ratio(1, 2) },
      {
        page: 'empty',
      },
    ),
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
  // The section draws in the order of its cells: each key in its order, each
  // score in its order.
  const expected = bootstrap(7);
  const cells = (key: string) => {
    const run = new RunLog(
      info,
      log.samples.filter((sample) => sample.metadata.page === key),
    ).run();
    return ['recall', 'precision'].map((name) => {
      const interval = expected.interval(run, name);
      const value = run.total(name).value;
      return `${value.toFixed(3)} [${interval.low.toFixed(3)}, ${interval.high.toFixed(3)}]`;
    });
  };
  const empty = cells('empty');
  const offers = cells('offers');

  const slices = new Slices(log, {
    scores: [
      { name: 'recall', higherIsBetter: true },
      { name: 'precision', higherIsBetter: true },
    ],
    slices: [page],
    bootstrap: bootstrap(7),
  });

  assert.deepEqual(tables(slices), [
    {
      columns: ['page', 'tests', 'recall', 'precision'],
      rows: [
        ['empty', '2', ...empty],
        ['offers', '3', ...offers],
      ],
    },
  ]);
});

test('the keys of a slice sort as numbers, so 2 comes before 10', () => {
  const log = new RunLog(info, [
    sample('a', { recall: new Ratio(1, 1) }, { length: '10' }),
    sample('b', { recall: new Ratio(1, 1) }, { length: '2' }),
    sample('c', { recall: new Ratio(1, 1) }, { length: '1' }),
  ]);

  const slices = new Slices(log, {
    scores: [{ name: 'recall', higherIsBetter: true }],
    slices: [length],
    bootstrap: firstTest(),
  });

  assert.deepEqual(
    tables(slices).map(({ rows }) => rows.map(([key]) => key)),
    [['1', '2', '10']],
  );
});

test('the tests cell counts each test once, whatever its epochs', () => {
  const log = new RunLog(info, [
    sample('a', { recall: new Ratio(9, 10) }, { epoch: 0 }),
    sample('a', { recall: new Ratio(7, 10) }, { epoch: 1 }),
    sample('b', { recall: new Ratio(8, 10) }),
  ]);

  const slices = new Slices(log, {
    scores: [{ name: 'recall', higherIsBetter: true }],
    slices: [page],
    bootstrap: firstTest(),
  });

  assert.deepEqual(
    tables(slices).map(({ rows }) => rows.map((row) => row.slice(0, 2))),
    [[['offers', '2']]],
  );
});

test('each slice has its own table, in the order of the slices, with neutral cells', () => {
  const log = new RunLog(info, [
    sample('a', { recall: new Ratio(9, 10) }, { length: '2' }),
    sample('b', { recall: new Ratio(1, 10) }, { page: 'empty' }),
  ]);

  const slices = new Slices(log, {
    scores: [{ name: 'recall', higherIsBetter: true }],
    slices: [length, page],
    bootstrap: firstTest(),
  });

  assert.deepEqual(
    {
      tables: tables(slices),
      tones: new Set(
        slices.primitives.flatMap((primitive) =>
          primitive instanceof Table
            ? primitive.rows.flat().map(({ tone }) => tone)
            : [],
        ),
      ),
    },
    {
      tables: [
        {
          columns: ['length', 'tests', 'recall'],
          rows: [
            ['1', '1', '0.100 [0.100, 0.100]'],
            ['2', '1', '0.900 [0.900, 0.900]'],
          ],
        },
        {
          columns: ['page', 'tests', 'recall'],
          rows: [
            ['empty', '1', '0.100 [0.100, 0.100]'],
            ['offers', '1', '0.900 [0.900, 0.900]'],
          ],
        },
      ],
      tones: new Set(['neutral']),
    },
  );
});

void test.each(
  [
    {
      name: 'a score that is better higher names its lowest key',
      score: { name: 'recall', higherIsBetter: true },
      samples: [
        sample('a', { recall: new Ratio(9, 10) }, { length: '2' }),
        sample('b', { recall: new Ratio(2, 10) }),
        sample('c', { recall: new Ratio(6, 10) }, { page: 'empty' }),
      ],
      claim:
        'recall is lowest on length = 1: 0.400 [0.200, 0.200] over 2 tests, against 0.567 over the run',
    },
    {
      name: 'a score that is better lower names its highest key',
      score: { name: 'cost', higherIsBetter: false },
      samples: [
        sample('a', { cost: new Ratio(9, 10) }, { length: '2' }),
        sample('b', { cost: new Ratio(3, 10) }, { length: '2' }),
        sample('c', { cost: new Ratio(8, 10) }, { page: 'empty' }),
        sample('d', { cost: new Ratio(10, 10) }),
      ],
      claim:
        'cost is highest on length = 1: 0.900 [0.800, 0.800] over 2 tests, against 0.750 over the run',
    },
    {
      name: 'a tie goes to the first key, in the order of the slices',
      score: { name: 'recall', higherIsBetter: true },
      samples: [
        sample('a', { recall: new Ratio(9, 10) }, { length: '2' }),
        sample('b', { recall: new Ratio(1, 10) }, { page: 'empty' }),
      ],
      claim:
        'recall is lowest on page = empty: 0.100 [0.100, 0.100] over 1 test, against 0.500 over the run',
    },
    {
      name: 'a tie in one slice goes to the first key in its order',
      score: { name: 'recall', higherIsBetter: true },
      samples: [
        sample('a', { recall: new Ratio(5, 10) }, { page: 'offers' }),
        sample('b', { recall: new Ratio(5, 10) }, { page: 'empty' }),
      ],
      claim:
        'recall is lowest on page = empty: 0.500 [0.500, 0.500] over 1 test, against 0.500 over the run',
    },
    {
      name: 'a key where no sample gives the score is passed over',
      score: { name: 'recall', higherIsBetter: true },
      samples: [
        sample('a', { recall: new Ratio(9, 10) }, { length: '2' }),
        sample('b', {}, { page: 'empty' }),
        sample('c', { recall: new Ratio(7, 10) }, { length: '2' }),
      ],
      claim:
        'recall is lowest on page = offers: 0.800 [0.900, 0.900] over 2 tests, against 0.800 over the run',
    },
    {
      name: 'a run with no samples has no value on any key',
      score: { name: 'recall', higherIsBetter: true },
      samples: [],
      claim: 'recall has no value on any key of page and length',
    },
  ] satisfies {
    name: string;
    score: Score;
    samples: Sample<string, null>[];
    claim: string;
  }[],
  ({ name, score, samples, claim }) =>
    test(`the claim: ${name}`, () => {
      const slices = new Slices(new RunLog(info, samples), {
        scores: [score],
        slices: [page, length],
        bootstrap: firstTest(),
      });

      assert.equal(slices.claim, claim);
    }),
);

test('a key where a score has no whole, such as recall on pages with no expected value, shows a dash, and the claim names the only key with a value', () => {
  const log = new RunLog(info, [
    sample('a', { recall: new Ratio(8, 10) }, { page: 'offers' }),
    sample('b', { recall: new Ratio(0, 0) }, { page: 'empty' }),
  ]);

  const slices = new Slices(log, {
    scores: [{ name: 'recall', higherIsBetter: true }],
    slices: [page],
    bootstrap: firstTest(),
  });

  assert.deepEqual(tables(slices)[0]?.rows, [
    ['empty', '1', '—'],
    ['offers', '1', '0.800 [0.800, 0.800]'],
  ]);
  assert.equal(
    slices.claim,
    'recall has a value only on page = offers: 0.800 [0.800, 0.800] over 1 test',
  );
});

test('the claim reads the first score only', () => {
  const log = new RunLog(info, [
    sample('a', { recall: new Ratio(9, 10), cost: new Ratio(1, 10) }),
    sample(
      'b',
      { recall: new Ratio(1, 10), cost: new Ratio(9, 10) },
      { page: 'empty' },
    ),
  ]);

  const slices = new Slices(log, {
    scores: [
      { name: 'cost', higherIsBetter: true },
      { name: 'recall', higherIsBetter: true },
    ],
    slices: [page],
    bootstrap: firstTest(),
  });

  assert.match(slices.claim, /^cost is lowest on page = offers: /);
});

test('a score that no sample of the run gives is an error, not a column of dashes', () => {
  const log = new RunLog(info, [sample('a', { recall: new Ratio(1, 1) })]);

  assert.throws(
    () =>
      new Slices(log, {
        scores: [
          { name: 'recall', higherIsBetter: true },
          { name: 'recal', higherIsBetter: true },
        ],
        slices: [page],
        bootstrap: firstTest(),
      }),
    { message: 'No scorecard of the run gave a ratio named "recal"' },
  );
});

void test.each(
  [
    {
      name: 'no scores',
      scores: [],
      slices: [page],
      message: 'A Slices section needs a score to show',
    },
    {
      name: 'no slices',
      scores: [{ name: 'recall', higherIsBetter: true }],
      slices: [],
      message: 'A Slices section needs a slice to show',
    },
  ] satisfies {
    name: string;
    scores: Score[];
    slices: Slice<string, null>[];
    message: string;
  }[],
  ({ name, scores, slices, message }) =>
    test(`a Slices section with ${name} is a RangeError`, () => {
      assert.throws(
        () =>
          new Slices(
            new RunLog(info, [sample('a', { recall: new Ratio(1, 1) })]),
            { scores, slices, bootstrap: firstTest() },
          ),
        { name: 'RangeError', message },
      );
    }),
);

test('a Slices section with a key where no sample gives the score renders as HTML and Markdown with its claim and with no NaN', () => {
  const slices = new Slices(
    new RunLog(info, [
      sample('a', { recall: new Ratio(9, 10) }),
      sample('b', {}, { page: 'empty' }),
    ]),
    {
      scores: [{ name: 'recall', higherIsBetter: true }],
      slices: [page],
      bootstrap: firstTest(),
    },
  );
  const report = new Page('offers', [slices]);

  const html = new HtmlRenderer().render(report);
  const markdown = new MarkdownRenderer().render(report);

  // remark escapes the bracket that could start a link.
  assert.deepEqual(
    {
      claim: slices.claim,
      html: { claim: html.includes(slices.claim), nan: html.includes('NaN') },
      markdown: {
        claim: markdown.includes(
          '## recall has a value only on page = offers: 0.900 \\[0.900, 0.900] over 1 test',
        ),
        nan: markdown.includes('NaN'),
      },
      empty: tables(slices)[0]?.rows[0],
    },
    {
      claim:
        'recall has a value only on page = offers: 0.900 [0.900, 0.900] over 1 test',
      html: { claim: true, nan: false },
      markdown: { claim: true, nan: false },
      empty: ['empty', '1', '—'],
    },
  );
});
