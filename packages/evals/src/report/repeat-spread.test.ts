import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import { Note, Ratio, RunLog, type Sample, Table } from '../index.ts';
import { render } from '../testing/render.ts';
import { RepeatSpread, type Score } from './index.ts';

const info = { id: 'eval-1', label: 'model', createdAt: new Date(0) };

// One answered sample of a test in an epoch, with a ratio for each name.
const sample = (
  testId: string,
  epoch: number,
  ratios: Record<string, Ratio>,
): Sample<string, null> => ({
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
});

// The samples of a test, one for each epoch, giving the name each value.
const epochs = (testId: string, name: string, values: readonly number[]) =>
  values.map((value, epoch) =>
    sample(testId, epoch, { [name]: new Ratio(value, 1) }),
  );

const f1: Score[] = [{ name: 'f1', higherIsBetter: true }];

const cells = (table: Table) =>
  table.rows.map((row) => row.map(({ text }) => text));

const parts = (section: RepeatSpread<string, null>) => {
  const [stability, widest] = section.primitives;
  assert.ok(stability instanceof Table);
  return { stability, widest };
};

const spreadRows = (section: RepeatSpread<string, null>) => {
  const { widest } = parts(section);
  assert.ok(widest instanceof Table);
  return cells(widest);
};

test('the spread of a test is the highest less the lowest value of its epochs', () => {
  const section = new RepeatSpread(
    new RunLog(info, epochs('a', 'f1', [0.25, 1, 0.5])),
    { scores: f1, widest: 20 },
  );

  assert.deepEqual(
    { columns: parts(section).stability.columns, rows: spreadRows(section) },
    {
      columns: ['score', 'tests with epochs', 'unstable', 'share'],
      rows: [['a', 'f1', '0.750', '0.250, 1.000, 0.500']],
    },
  );
});

test('the epochs of a test are listed in epoch order, whatever the order of its samples', () => {
  const section = new RepeatSpread(
    new RunLog(info, [
      sample('a', 2, { f1: new Ratio(1, 2) }),
      sample('a', 0, { f1: new Ratio(0, 1) }),
      sample('a', 1, { f1: new Ratio(1, 1) }),
    ]),
    { scores: f1, widest: 20 },
  );

  assert.deepEqual(spreadRows(section), [
    ['a', 'f1', '1.000', '0.000, 1.000, 0.500'],
  ]);
});

test('an epoch with a ratio of no whole or without the score shows a dash and is left out of the spread', () => {
  const section = new RepeatSpread(
    new RunLog(info, [
      sample('a', 0, { f1: new Ratio(1, 2) }),
      sample('a', 1, { f1: new Ratio(0, 0) }),
      sample('a', 2, {}),
      sample('a', 3, { f1: new Ratio(3, 4) }),
    ]),
    { scores: f1, widest: 20 },
  );

  assert.deepEqual(spreadRows(section), [
    ['a', 'f1', '0.250', '0.500, —, —, 0.750'],
  ]);
});

test('a test with one epoch with a value is not counted for stability', () => {
  const section = new RepeatSpread(
    new RunLog(info, [
      ...epochs('a', 'f1', [1, 0]),
      sample('b', 0, { f1: new Ratio(1, 1) }),
      sample('b', 1, { f1: new Ratio(0, 0) }),
      sample('c', 0, { f1: new Ratio(1, 1) }),
    ]),
    { scores: f1, widest: 20 },
  );

  assert.deepEqual(
    { stability: cells(parts(section).stability), spread: spreadRows(section) },
    {
      stability: [['f1', '1', '1', '100%']],
      spread: [['a', 'f1', '1.000', '1.000, 0.000']],
    },
  );
});

test('the stability table gives each score its tests with epochs, the unstable ones and their share', () => {
  const section = new RepeatSpread(
    new RunLog(info, [
      sample('a', 0, { f1: new Ratio(1, 1), recall: new Ratio(1, 1) }),
      sample('a', 1, { f1: new Ratio(0, 1), recall: new Ratio(1, 1) }),
      sample('b', 0, { f1: new Ratio(1, 1), recall: new Ratio(1, 1) }),
      sample('b', 1, { f1: new Ratio(1, 1), recall: new Ratio(1, 1) }),
      sample('c', 0, { f1: new Ratio(1, 1), recall: new Ratio(1, 1) }),
      sample('c', 1, { f1: new Ratio(1, 1), recall: new Ratio(1, 1) }),
      sample('c', 2, { f1: new Ratio(1, 1), recall: new Ratio(1, 1) }),
      sample('d', 0, { precision: new Ratio(1, 1) }),
    ]),
    {
      scores: [
        ...f1,
        { name: 'recall', higherIsBetter: true },
        { name: 'precision', higherIsBetter: true },
      ],
      widest: 20,
    },
  );

  assert.deepEqual(cells(parts(section).stability), [
    ['f1', '3', '1', '33.3%'],
    ['recall', '3', '0', '0%'],
    ['precision', '0', '0', '—'],
  ]);
});

test('the unstable tests are listed widest first, and ties keep the order of the scores and then of the tests', () => {
  const section = new RepeatSpread(
    new RunLog(info, [
      sample('a', 0, { f1: new Ratio(1, 2), recall: new Ratio(0, 1) }),
      sample('a', 1, { f1: new Ratio(1, 1), recall: new Ratio(1, 1) }),
      sample('b', 0, { f1: new Ratio(0, 1), recall: new Ratio(1, 2) }),
      sample('b', 1, { f1: new Ratio(1, 1), recall: new Ratio(1, 1) }),
      sample('c', 0, { f1: new Ratio(1, 2), recall: new Ratio(1, 1) }),
      sample('c', 1, { f1: new Ratio(1, 1), recall: new Ratio(1, 1) }),
    ]),
    { scores: [...f1, { name: 'recall', higherIsBetter: true }], widest: 20 },
  );

  assert.deepEqual(
    spreadRows(section).map(([testId, score, spread]) => [
      testId,
      score,
      spread,
    ]),
    [
      ['b', 'f1', '1.000'],
      ['a', 'recall', '1.000'],
      ['a', 'f1', '0.500'],
      ['c', 'f1', '0.500'],
      ['b', 'recall', '0.500'],
    ],
  );
});

test('widest caps the rows of the spread table, and the stability table still counts every test', () => {
  const section = new RepeatSpread(
    new RunLog(info, [
      ...epochs('a', 'f1', [0, 0.25]),
      ...epochs('b', 'f1', [0, 1]),
      ...epochs('c', 'f1', [0, 0.5]),
    ]),
    { scores: f1, widest: 2 },
  );

  assert.deepEqual(
    { stability: cells(parts(section).stability), spread: spreadRows(section) },
    {
      stability: [['f1', '3', '3', '100%']],
      spread: [
        ['b', 'f1', '1.000', '0.000, 1.000'],
        ['c', 'f1', '0.500', '0.000, 0.500'],
      ],
    },
  );
});

test('a score that no sample of the run gives is an error, not an empty row', () => {
  const log = new RunLog(info, epochs('a', 'f1', [0.5, 1]));

  assert.throws(
    () =>
      new RepeatSpread(log, {
        scores: [
          { name: 'f1', higherIsBetter: true },
          { name: 'f11', higherIsBetter: true },
        ],
        widest: 20,
      }),
    {
      name: 'Error',
      message: 'No scorecard of the run gave a ratio named "f11"',
    },
  );
});

test('a run where no test is unstable has a note in place of the spread table', () => {
  const section = new RepeatSpread(
    new RunLog(info, [
      ...epochs('a', 'f1', [0.5, 0.5]),
      ...epochs('b', 'f1', [1, 1]),
    ]),
    { scores: f1, widest: 20 },
  );

  const { widest } = parts(section);

  assert.ok(widest instanceof Note);
  assert.equal(
    widest.text,
    'No test gives another value of a score in another epoch',
  );
});

void test.each(
  [
    {
      name: 'no test has two epochs with a value',
      samples: [
        sample('a', 0, { f1: new Ratio(1, 1) }),
        sample('a', 1, { f1: new Ratio(0, 0) }),
      ],
      scores: f1,
      claim:
        'No test has two epochs with a value of f1, so its spread cannot be read',
    },
    {
      name: 'one test gives the same value in each epoch',
      samples: epochs('a', 'f1', [1, 1]),
      scores: f1,
      claim: 'The one test gives the same f1 in each epoch',
    },
    {
      name: 'every test gives the same value in each epoch',
      samples: [...epochs('a', 'f1', [1, 1]), ...epochs('b', 'f1', [0, 0])],
      scores: f1,
      claim: 'Every one of the 2 tests gives the same f1 in each epoch',
    },
    {
      name: 'one of one test spreads',
      samples: epochs('a', 'f1', [0.4, 1]),
      scores: f1,
      claim:
        '1 of 1 test gives another f1 in another epoch; a spreads widest, from 0.400 to 1.000',
    },
    {
      name: 'some tests spread',
      samples: [
        ...epochs('a', 'f1', [1, 0.5]),
        ...epochs('b', 'f1', [0, 1, 0]),
        ...epochs('c', 'f1', [1, 1]),
      ],
      scores: f1,
      claim:
        '2 of 3 tests give another f1 in another epoch; b spreads widest, from 0.000 to 1.000',
    },
    {
      name: 'only a later score spreads',
      samples: [
        sample('a', 0, { f1: new Ratio(1, 1), recall: new Ratio(0, 1) }),
        sample('a', 1, { f1: new Ratio(1, 1), recall: new Ratio(1, 1) }),
      ],
      scores: [...f1, { name: 'recall', higherIsBetter: true }],
      claim: 'The one test gives the same f1 in each epoch',
    },
  ] satisfies {
    name: string;
    samples: Sample<string, null>[];
    scores: Score[];
    claim: string;
  }[],
  ({ name, samples, scores, claim }) =>
    test(`the claim when ${name}`, () => {
      const section = new RepeatSpread(new RunLog(info, samples), {
        scores,
        widest: 20,
      });

      assert.equal(section.claim, claim);
    }),
);

void test.each(
  [
    {
      name: 'no scores',
      scores: [],
      widest: 20,
      message: 'A RepeatSpread section needs a score to show',
    },
    {
      name: 'a widest of 0',
      scores: f1,
      widest: 0,
      message:
        'A RepeatSpread section shows a positive whole number of rows, not 0',
    },
    {
      name: 'a widest that is not whole',
      scores: f1,
      widest: 2.5,
      message:
        'A RepeatSpread section shows a positive whole number of rows, not 2.5',
    },
    {
      name: 'a widest that is not a number',
      scores: f1,
      widest: Number.NaN,
      message:
        'A RepeatSpread section shows a positive whole number of rows, not NaN',
    },
  ] satisfies {
    name: string;
    scores: Score[];
    widest: number;
    message: string;
  }[],
  ({ name, scores, widest, message }) =>
    test(`a RepeatSpread section with ${name} is a RangeError`, () => {
      assert.throws(
        () =>
          new RepeatSpread(new RunLog(info, epochs('a', 'f1', [1, 0])), {
            scores,
            widest,
          }),
        { name: 'RangeError', message },
      );
    }),
);

test('a RepeatSpread section with an epoch with no value renders as HTML and Markdown with its claim and with no NaN', () => {
  const section = new RepeatSpread(
    new RunLog(info, [
      sample('a', 0, { f1: new Ratio(0, 1) }),
      sample('a', 1, { f1: new Ratio(0, 0) }),
      sample('a', 2, { f1: new Ratio(1, 1) }),
      sample('b', 0, { f1: new Ratio(1, 1) }),
    ]),
    { scores: f1, widest: 20 },
  );
  const { html, markdown, heading } = render(section);

  assert.deepEqual(
    {
      claim: section.claim,
      html: { claim: html.includes(section.claim), nan: html.includes('NaN') },
      markdown: { heading, nan: markdown.includes('NaN') },
    },
    {
      claim:
        '1 of 1 test gives another f1 in another epoch; a spreads widest, from 0.000 to 1.000',
      html: { claim: true, nan: false },
      markdown: { heading: section.claim, nan: false },
    },
  );
});
