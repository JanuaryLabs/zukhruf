import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import { RunLog, type Sample, Table, type Usage } from '../index.ts';
import {
  CostAndLatency,
  HtmlRenderer,
  MarkdownRenderer,
  Page,
} from './index.ts';

const info = { id: 'eval-1', label: 'model', createdAt: new Date(0) };

// One answered sample of a test, with the call that gave its answer and the
// time it took.
const sample = (
  testId: string,
  {
    replayed = false,
    usage,
    latencyMs = 0,
  }: {
    replayed?: boolean;
    usage?: Usage;
    latencyMs?: number;
  } = {},
): Sample<string, null> => ({
  test: testId,
  epoch: 0,
  weight: 1,
  case: null,
  scorecard: { ratios: new Map() },
  metadata: {},
  latencyMs,
  call: { replayed, usage },
  outcome: 'answered',
  answer: 'an answer',
});

const section = (samples: Sample<string, null>[]) =>
  new CostAndLatency(new RunLog(info, samples));

// The text of each row of the section's table, by its label.
const rows = (samples: Sample<string, null>[]) => {
  const [table] = section(samples).primitives;
  assert.ok(table instanceof Table);
  return Object.fromEntries(
    table.rows.map(([label, ...cells]) => [
      label?.text,
      cells.map(({ text }) => text),
    ]),
  );
};

test('the table has a row for each number, with a column for the answers and one for the new calls, all neutral', () => {
  const [table] = section([sample('a')]).primitives;
  assert.ok(table instanceof Table);

  assert.deepEqual(
    {
      columns: table.columns,
      labels: table.rows.map(([label]) => label?.text),
      tones: new Set(table.rows.flat().map(({ tone }) => tone)),
    },
    {
      columns: ['', 'answers', 'new calls'],
      labels: [
        'samples',
        'input tokens',
        'output tokens',
        'cached input tokens',
        'cost',
        'latency p50',
        'latency p90',
      ],
      tones: new Set(['neutral']),
    },
  );
});

test('a replay counts its tokens in the answers only, and a sample with no usage counts in the samples but not in the sums', () => {
  const table = rows([
    sample('a', {
      usage: { input: 1000, output: 200, cachedInput: 300, cost: undefined },
    }),
    sample('b', {
      replayed: true,
      usage: { input: 12000, output: 50, cachedInput: 7, cost: undefined },
    }),
    sample('c'),
    sample('d', { replayed: true }),
  ]);

  assert.deepEqual(
    {
      samples: table.samples,
      input: table['input tokens'],
      output: table['output tokens'],
      cached: table['cached input tokens'],
    },
    {
      samples: ['4', '2'],
      input: ['13,000', '1,000'],
      output: ['250', '200'],
      cached: ['307', '300'],
    },
  );
});

void test.each(
  [
    {
      name: 'the answers cost every sample with a cost, and the run spent its new calls',
      samples: [
        sample('a', {
          usage: { input: 1, output: 1, cachedInput: 0, cost: 0.25 },
        }),
        sample('b', {
          replayed: true,
          usage: { input: 1, output: 1, cachedInput: 0, cost: 1.25 },
        }),
      ],
      cost: ['$1.50', '$0.25'],
    },
    {
      name: 'a sample whose cost is undefined is left out of the sums',
      samples: [
        sample('a', {
          usage: { input: 1, output: 1, cachedInput: 0, cost: 0.5 },
        }),
        sample('b', {
          usage: { input: 1, output: 1, cachedInput: 0, cost: undefined },
        }),
      ],
      cost: ['$0.50', '$0.50'],
    },
    {
      name: 'no sample has a cost',
      samples: [
        sample('a', {
          usage: { input: 1, output: 1, cachedInput: 0, cost: undefined },
        }),
        sample('b'),
      ],
      cost: ['—', '—'],
    },
    {
      name: 'only a replay has a cost',
      samples: [
        sample('a'),
        sample('b', {
          replayed: true,
          usage: { input: 1, output: 1, cachedInput: 0, cost: 0.01234 },
        }),
      ],
      cost: ['$0.0123', '—'],
    },
    {
      name: 'a cost of thousands of dollars',
      samples: [
        sample('a', {
          usage: { input: 1, output: 1, cachedInput: 0, cost: 1234.5 },
        }),
      ],
      cost: ['$1,234.50', '$1,234.50'],
    },
  ] satisfies {
    name: string;
    samples: Sample<string, null>[];
    cost: string[];
  }[],
  ({ name, samples, cost }) =>
    test(`the cost row when ${name}`, () => {
      assert.deepEqual(rows(samples).cost, cost);
    }),
);

test('the latency is the Linear p50 and p90 of the new calls in seconds, and a replay is left out', () => {
  // Sorted, 400, 1000, 1200, 3000, 5000: the median is the value at index 2,
  // and the 90th percentile is at 3.6, 3000 + 0.6 × 2000 = 4200, as
  // numpy.percentile gives.
  const table = rows([
    sample('a', { latencyMs: 3000 }),
    sample('b', { latencyMs: 400 }),
    sample('c', { latencyMs: 5000 }),
    sample('d', { latencyMs: 1000 }),
    sample('e', { latencyMs: 1200 }),
    sample('f', { replayed: true, latencyMs: 1 }),
    sample('g', { replayed: true, latencyMs: 2 }),
  ]);

  assert.deepEqual(
    { p50: table['latency p50'], p90: table['latency p90'] },
    { p50: ['—', '1.20 s'], p90: ['—', '4.20 s'] },
  );
});

test('a latency shows in seconds with two decimals', () => {
  const table = rows([sample('a', { latencyMs: 1237 })]);

  assert.deepEqual(table['latency p50'], ['—', '1.24 s']);
});

test('with no new call the latency is a dash', () => {
  const table = rows([sample('a', { replayed: true, latencyMs: 900 })]);

  assert.deepEqual(
    { p50: table['latency p50'], p90: table['latency p90'] },
    { p50: ['—', '—'], p90: ['—', '—'] },
  );
});

void test.each(
  [
    {
      name: 'some answers were new calls with a cost',
      samples: [
        sample('a', {
          latencyMs: 1000,
          usage: { input: 1, output: 1, cachedInput: 0, cost: 0.5 },
        }),
        sample('b', {
          latencyMs: 2000,
          usage: { input: 1, output: 1, cachedInput: 0, cost: 0.25 },
        }),
        sample('c', {
          replayed: true,
          latencyMs: 5,
          usage: { input: 1, output: 1, cachedInput: 0, cost: 9 },
        }),
      ],
      claim:
        '2 of 3 answers were new calls, which spent $0.75; an answer took 1.50 s at the median and 1.90 s at the 90th percentile',
    },
    {
      name: 'one of many answers was a new call',
      samples: [
        sample('a', {
          latencyMs: 1240,
          usage: { input: 1, output: 1, cachedInput: 0, cost: 0.01 },
        }),
        sample('b', { replayed: true }),
      ],
      claim:
        '1 of 2 answers was a new call, which spent $0.01; an answer took 1.24 s at the median and 1.24 s at the 90th percentile',
    },
    {
      name: 'the one answer was a new call with no cost',
      samples: [sample('a', { latencyMs: 800 })],
      claim:
        '1 of 1 answer was a new call, at a price that the run does not know; an answer took 0.80 s at the median and 0.80 s at the 90th percentile',
    },
    {
      name: 'every answer was replayed',
      samples: [
        sample('a', { replayed: true }),
        sample('b', { replayed: true }),
      ],
      claim:
        'All 2 answers were replayed, so the run spent nothing and its latency cannot be read',
    },
    {
      name: 'the one answer was replayed',
      samples: [sample('a', { replayed: true })],
      claim:
        'The one answer was replayed, so the run spent nothing and its latency cannot be read',
    },
  ] satisfies {
    name: string;
    samples: Sample<string, null>[];
    claim: string;
  }[],
  ({ name, samples, claim }) =>
    test(`the claim when ${name}`, () => {
      assert.equal(section(samples).claim, claim);
    }),
);

test('a CostAndLatency section of a log with no samples is a RangeError', () => {
  assert.throws(() => section([]), {
    name: 'RangeError',
    message: 'A CostAndLatency section needs a sample to show',
  });
});

void test.each(
  [
    {
      name: 'with new calls',
      samples: [
        sample('a', {
          latencyMs: 1000,
          usage: { input: 10, output: 2, cachedInput: 0, cost: undefined },
        }),
        sample('b', { replayed: true }),
      ],
    },
    {
      name: 'with every answer replayed',
      samples: [sample('a', { replayed: true })],
    },
  ] satisfies { name: string; samples: Sample<string, null>[] }[],
  ({ name, samples }) =>
    test(`a CostAndLatency section ${name} renders as HTML and Markdown with its claim and with no NaN`, () => {
      const built = section(samples);
      const report = new Page('offers', [built]);

      const html = new HtmlRenderer().render(report);
      const markdown = new MarkdownRenderer().render(report);

      assert.deepEqual(
        {
          html: {
            claim: html.includes(built.claim),
            nan: html.includes('NaN'),
          },
          markdown: {
            claim: markdown.includes(`## ${built.claim}`),
            nan: markdown.includes('NaN'),
          },
        },
        {
          html: { claim: true, nan: false },
          markdown: { claim: true, nan: false },
        },
      );
    }),
);
