import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import {
  Note,
  Ratio,
  RunLog,
  RunPair,
  type Sample,
  Scatter,
  Table,
} from '../index.ts';
import {
  HtmlRenderer,
  MarkdownRenderer,
  Page,
  type Score,
  TestsMoved,
} from './index.ts';

// The epochs of each test, in epoch order, each with a ratio for each name.
type Epochs = Record<string, readonly Record<string, Ratio>[]>;

const log = (label: string, tests: Epochs) =>
  new RunLog(
    { id: label, label, createdAt: new Date(0) },
    Object.entries(tests).flatMap(([testId, epochs]) =>
      epochs.map((ratios, epoch): Sample<string, null> => ({
        test: testId,
        epoch,
        weight: 1,
        case: null,
        scorecard: { ratios: new Map(Object.entries(ratios)) },
        metadata: {},
        latencyMs: 0,
        call: { replayed: false, usage: undefined },
        outcome: 'answered',
        answer: 'an answer',
      })),
    ),
  );

const pairOf = (baseline: Epochs, change: Epochs) =>
  new RunPair(log('Haiku', baseline), log('DeepSeek', change));

// One epoch of each test, with the value of one score as a ratio of 8.
const eighths = (name: string, values: Record<string, number>): Epochs =>
  Object.fromEntries(
    Object.entries(values).map(([testId, part]) => [
      testId,
      [{ [name]: new Ratio(part, 8) }],
    ]),
  );

const higher = (name: string): Score => ({ name, higherIsBetter: true });

const scatters = (section: TestsMoved<string, null>) =>
  section.primitives.filter((primitive) => primitive instanceof Scatter);

const moved = (section: TestsMoved<string, null>) => {
  const primitive = section.primitives.at(-1);
  assert.ok(primitive instanceof Table);
  return {
    columns: primitive.columns,
    rows: primitive.rows.map((cells) => cells.map(({ text }) => text)),
    tones: primitive.rows.flatMap((cells) => cells.map(({ tone }) => tone)),
  };
};

test("a test's value is the mean of its epochs, a ratio of the sums of its parts and wholes", () => {
  const section = new TestsMoved(
    pairOf(
      { a: [{ recall: new Ratio(1, 1) }, { recall: new Ratio(0, 3) }] },
      { a: [{ recall: new Ratio(1, 1) }, { recall: new Ratio(1, 1) }] },
    ),
    { scores: [higher('recall')], widest: 10 },
  );

  assert.deepEqual(
    scatters(section).map(({ points }) => points),
    [[{ label: 'a', x: 0.25, y: 1 }]],
  );
});

test('a test whose mean has no whole, or that no epoch gives the score, has no point and does not move', () => {
  const section = new TestsMoved(
    pairOf(
      {
        a: [{ recall: new Ratio(1, 2) }],
        b: [{ recall: new Ratio(0, 0) }],
        c: [{ recall: new Ratio(1, 2) }],
      },
      {
        a: [{ recall: new Ratio(1, 2) }],
        b: [{ recall: new Ratio(1, 1) }],
        c: [{ precision: new Ratio(1, 1) }],
      },
    ),
    { scores: [higher('recall')], widest: 10 },
  );

  assert.deepEqual(
    {
      points: scatters(section).map(({ points }) => points),
      last: section.primitives.at(-1),
    },
    {
      points: [[{ label: 'a', x: 0.5, y: 0.5 }]],
      last: new Note('No test moved'),
    },
  );
});

test("each score has a scatter of the tests in both runs, its axes named by the score and each log's label", () => {
  const section = new TestsMoved(
    pairOf(
      {
        a: [{ recall: new Ratio(1, 4), f1: new Ratio(1, 2) }],
        b: [{ recall: new Ratio(3, 4), f1: new Ratio(1, 1) }],
      },
      {
        a: [{ recall: new Ratio(2, 4), f1: new Ratio(1, 2) }],
        b: [{ recall: new Ratio(3, 4), f1: new Ratio(0, 1) }],
      },
    ),
    { scores: [higher('recall'), higher('f1')], widest: 10 },
  );

  assert.deepEqual(
    scatters(section).map(({ x, y, points }) => ({ x, y, points })),
    [
      {
        x: 'recall · Haiku',
        y: 'recall · DeepSeek',
        points: [
          { label: 'a', x: 0.25, y: 0.5 },
          { label: 'b', x: 0.75, y: 0.75 },
        ],
      },
      {
        x: 'f1 · Haiku',
        y: 'f1 · DeepSeek',
        points: [
          { label: 'a', x: 0.5, y: 0.5 },
          { label: 'b', x: 1, y: 0 },
        ],
      },
    ],
  );
});

void test.each(
  [
    {
      widest: 10,
      rows: [
        ['b', 's1', '0.500', '0.000', '-0.500'],
        ['a', 's1', '0.250', '0.500', '+0.250'],
        ['a', 's2', '0.500', '0.250', '-0.250'],
        ['c', 's2', '0.000', '0.250', '+0.250'],
        ['b', 's2', '0.000', '0.125', '+0.125'],
      ],
    },
    {
      widest: 3,
      rows: [
        ['b', 's1', '0.500', '0.000', '-0.500'],
        ['a', 's1', '0.250', '0.500', '+0.250'],
        ['a', 's2', '0.500', '0.250', '-0.250'],
      ],
    },
  ],
  ({ widest, rows }) =>
    test(`the moved table lists the largest move first, signed, ties in the order of the scores and then the tests, at most ${widest} rows`, () => {
      const at = (s1: number, s2: number) => [
        { s1: new Ratio(s1, 8), s2: new Ratio(s2, 8) },
      ];
      const section = new TestsMoved(
        pairOf(
          { a: at(2, 4), b: at(4, 0), c: at(3, 0) },
          { a: at(4, 2), b: at(0, 1), c: at(3, 2) },
        ),
        { scores: [higher('s1'), higher('s2')], widest },
      );

      const table = moved(section);
      assert.deepEqual(
        {
          columns: table.columns,
          rows: table.rows,
          tones: new Set(table.tones),
        },
        {
          columns: ['test', 'score', 'baseline', 'change', 'moved'],
          rows,
          tones: new Set(['neutral']),
        },
      );
    }),
);

void test.each(
  [
    { higherIsBetter: true, better: 2, worse: 1 },
    { higherIsBetter: false, better: 1, worse: 2 },
  ],
  ({ higherIsBetter, better, worse }) =>
    test(`two rises and one fall read ${better} better and ${worse} worse when ${higherIsBetter ? 'higher' : 'lower'} is better`, () => {
      const section = new TestsMoved(
        pairOf(
          eighths('cost', { a: 1, b: 2, c: 4 }),
          eighths('cost', { a: 2, b: 4, c: 0 }),
        ),
        { scores: [{ name: 'cost', higherIsBetter }], widest: 10 },
      );

      assert.equal(
        section.claim,
        `3 of 3 tests moved on cost, ${better} better and ${worse} worse; c moved most, from 0.500 to 0.000`,
      );
    }),
);

void test.each(
  [
    {
      name: 'no test with a value in both runs',
      baseline: { a: [{ recall: new Ratio(0, 0) }] },
      change: { a: [{ recall: new Ratio(1, 1) }] },
      claim: 'No test has a value of recall in both runs',
    },
    {
      name: 'one test that did not move',
      baseline: eighths('recall', { a: 4 }),
      change: eighths('recall', { a: 4 }),
      claim:
        'No test moved on recall; the one test gives the same value in both runs',
    },
    {
      name: 'two tests that did not move',
      baseline: eighths('recall', { a: 4, b: 2 }),
      change: eighths('recall', { a: 4, b: 2 }),
      claim:
        'No test moved on recall; the 2 tests give the same value in both runs',
    },
    {
      name: 'the one test moved',
      baseline: eighths('recall', { a: 4 }),
      change: eighths('recall', { a: 6 }),
      claim:
        '1 of 1 test moved on recall, 1 better and 0 worse; a moved most, from 0.500 to 0.750',
    },
    {
      name: 'two of three tests moved, the largest move last',
      baseline: eighths('recall', { a: 4, b: 2, c: 8 }),
      change: eighths('recall', { a: 4, b: 3, c: 2 }),
      claim:
        '2 of 3 tests moved on recall, 1 better and 1 worse; c moved most, from 1.000 to 0.250',
    },
  ],
  ({ name, baseline, change, claim }) =>
    test(`the claim reads the first score: ${name}`, () => {
      const section = new TestsMoved(pairOf(baseline, change), {
        scores: [higher('recall')],
        widest: 10,
      });

      assert.equal(section.claim, claim);
    }),
);

test('the claim reads the first score only, though another score moved more', () => {
  const at = (recall: number, f1: number) => [
    { recall: new Ratio(recall, 8), f1: new Ratio(f1, 8) },
  ];
  const section = new TestsMoved(
    pairOf({ a: at(4, 0), b: at(2, 8) }, { a: at(4, 8), b: at(3, 0) }),
    { scores: [higher('recall'), higher('f1')], widest: 10 },
  );

  assert.equal(
    section.claim,
    '1 of 2 tests moved on recall, 1 better and 0 worse; b moved most, from 0.250 to 0.375',
  );
});

void test.each(
  [
    {
      widest: 0,
      message:
        'A TestsMoved section shows a positive whole number of rows, not 0',
    },
    {
      widest: 1.5,
      message:
        'A TestsMoved section shows a positive whole number of rows, not 1.5',
    },
    {
      widest: Number.NaN,
      message:
        'A TestsMoved section shows a positive whole number of rows, not NaN',
    },
  ],
  ({ widest, message }) =>
    test(`a widest of ${widest} is a RangeError`, () => {
      assert.throws(
        () =>
          new TestsMoved(
            pairOf(eighths('recall', { a: 1 }), eighths('recall', { a: 2 })),
            { scores: [higher('recall')], widest },
          ),
        { name: 'RangeError', message },
      );
    }),
);

test('a section with no score is a RangeError', () => {
  assert.throws(
    () =>
      new TestsMoved(
        pairOf(eighths('recall', { a: 1 }), eighths('recall', { a: 2 })),
        { scores: [], widest: 10 },
      ),
    {
      name: 'RangeError',
      message: 'A TestsMoved section needs a score to show',
    },
  );
});

void test.each(
  [
    {
      name: 'neither run gives',
      baseline: eighths('recall', { a: 1 }),
      change: eighths('recall', { a: 2 }),
    },
    {
      name: 'only the change gives',
      baseline: eighths('recall', { a: 1 }),
      change: eighths('recal', { a: 2 }),
    },
    {
      name: 'only the baseline gives',
      baseline: eighths('recal', { a: 1 }),
      change: eighths('recall', { a: 2 }),
    },
  ],
  ({ name, baseline, change }) =>
    test(`a score that ${name} is an Error, as Run#total throws`, () => {
      assert.throws(
        () =>
          new TestsMoved(pairOf(baseline, change), {
            scores: [higher('recal')],
            widest: 10,
          }),
        {
          name: 'Error',
          message: 'No scorecard of the run gave a ratio named "recal"',
        },
      );
    }),
);

test('tests moved render as HTML and Markdown with their claim and with no NaN', () => {
  const section = new TestsMoved(
    pairOf(
      {
        ...eighths('recall', { a: 4, b: 2 }),
        c: [{ recall: new Ratio(0, 0) }],
      },
      eighths('recall', { a: 4, b: 3, c: 1 }),
    ),
    { scores: [higher('recall')], widest: 10 },
  );
  const page = new Page('Haiku and DeepSeek', [section]);

  const html = new HtmlRenderer().render(page);
  const markdown = new MarkdownRenderer().render(page);

  assert.deepEqual(
    {
      html: { claim: html.includes(section.claim), nan: html.includes('NaN') },
      markdown: {
        claim: markdown.includes(
          '## 1 of 2 tests moved on recall, 1 better and 0 worse; b moved most, from 0.250 to 0.375',
        ),
        nan: markdown.includes('NaN'),
      },
    },
    {
      html: { claim: true, nan: false },
      markdown: { claim: true, nan: false },
    },
  );
});
