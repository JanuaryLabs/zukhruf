import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import { RunLog, type Sample, Table } from '../../index.ts';
import { render } from '../../testing/render.ts';
import { Case, FieldErrors, JsonValue, TreeWalk } from '../index.ts';

const info = { id: 'eval-1', label: 'model', createdAt: new Date(0) };

// One answered sample of a test, with the expected value of its case.
const answered = (
  testId: string,
  expected: unknown,
  answer: unknown,
  { epoch = 0 } = {},
): Sample<unknown, Case> => ({
  test: testId,
  epoch,
  weight: 1,
  case: new Case({ expected: JsonValue.from(expected).value, weight: 1 }),
  scorecard: { ratios: new Map() },
  metadata: {},
  latencyMs: 0,
  call: { replayed: false, usage: undefined },
  outcome: 'answered',
  answer,
});

// The rows of the one table of a section, as their texts.
const rows = (section: FieldErrors<Case>) => {
  const [table] = section.primitives;
  assert.ok(table instanceof Table);
  return table.rows.map((row) => row.map(({ text }) => text));
};

const fieldErrors = (samples: readonly Sample<unknown, Case>[]) =>
  new FieldErrors(new RunLog(info, samples), { comparer: new TreeWalk() });

void test.each(
  [
    {
      name: 'correct when the comparator agrees',
      expected: { size: 5000 },
      answer: { size: 5000 },
      row: ['$.size', '1', '0', '0', '0', '0'],
    },
    {
      name: 'partial when the two sides disagree and share a word',
      expected: { name: 'Acme Corp' },
      answer: { name: 'ACME, Inc.' },
      row: ['$.name', '0', '1', '0', '0', '0'],
    },
    {
      name: 'incorrect when the two sides share only an article, which is no word',
      expected: { city: 'The Hague' },
      answer: { city: 'the Bronx' },
      row: ['$.city', '0', '0', '1', '0', '0'],
    },
    {
      name: 'incorrect when two numbers differ, since their texts share no word',
      expected: { size: 5000 },
      answer: { size: 2500 },
      row: ['$.size', '0', '0', '1', '0', '0'],
    },
    {
      name: 'missed when only the expected side has it',
      expected: { gone: 'x' },
      answer: {},
      row: ['$.gone', '0', '0', '0', '1', '0'],
    },
    {
      name: 'spurious when only the answer has it',
      expected: {},
      answer: { extra: 'y' },
      row: ['$.extra', '0', '0', '0', '0', '1'],
    },
  ],
  ({ name, expected, answer, row }) =>
    test(`a leaf is ${name}`, () => {
      const section = fieldErrors([answered('a', expected, answer)]);

      assert.deepEqual(rows(section), [row]);
    }),
);

void test.each(
  [
    {
      name: 'correct when each of its leaves is correct',
      expected: [{ kind: 'credit', amount: 1 }],
      answer: [{ kind: 'credit', amount: 1 }],
      row: ['$.offers items', '1', '0', '0', '0', '0'],
    },
    {
      name: 'partial when some of its leaves are correct and some not',
      expected: [{ kind: 'credit', amount: 1 }],
      answer: [{ kind: 'credit', amount: 2 }],
      row: ['$.offers items', '0', '1', '0', '0', '0'],
    },
    {
      name: 'incorrect when none of its leaves is correct',
      expected: [{ kind: 'credit', amount: 1 }],
      answer: [{ kind: 'grant', amount: 2 }],
      row: ['$.offers items', '0', '0', '1', '0', '0'],
    },
    {
      name: 'missed when an expected item has no pair',
      expected: [{ kind: 'credit', amount: 1 }],
      answer: [],
      row: ['$.offers items', '0', '0', '0', '1', '0'],
    },
    {
      name: 'spurious when a stated item has no pair',
      expected: [],
      answer: [{ kind: 'credit', amount: 1 }],
      row: ['$.offers items', '0', '0', '0', '0', '1'],
    },
  ],
  ({ name, expected, answer, row }) =>
    test(`an item is ${name}`, () => {
      const section = fieldErrors([
        answered('a', { offers: expected }, { offers: answer }),
      ]);

      assert.deepEqual(rows(section)[0], row);
    }),
);

test('a row is a field without positions or the items of an array, in the order the walks first reach them, the array before the fields of its items', () => {
  const section = fieldErrors([
    answered(
      'a',
      {
        name: 'Acme',
        offers: [
          { kind: 'credit', amount: 100 },
          { kind: 'grant', amount: 200 },
          { kind: 'loan', amount: 300 },
        ],
      },
      {
        name: 'Acme',
        offers: [
          { kind: 'credit', amount: 100 },
          { kind: 'grant', amount: 250 },
          { kind: 'perk', amount: 1 },
          { kind: 'cloud', amount: 2 },
        ],
      },
    ),
    answered(
      'b',
      {
        offers: [
          { kind: 'credit', amount: 100 },
          { kind: 'grant', amount: 200 },
        ],
      },
      { offers: [{ kind: 'credit', amount: 100 }] },
    ),
  ]);

  assert.deepEqual(rows(section), [
    ['$.name', '1', '0', '0', '0', '0'],
    ['$.offers items', '2', '1', '1', '1', '1'],
    ['$.offers[*].kind', '3', '0', '1', '1', '1'],
    ['$.offers[*].amount', '2', '0', '2', '1', '1'],
  ]);
});

test('a failed sample is the answer null, so each of its expected leaves and items is missed', () => {
  const section = fieldErrors([
    {
      ...answered('a', { name: 'Acme', offers: [{ kind: 'credit' }] }, null),
      outcome: 'failed',
      answer: null,
      error: 'the provider timed out',
    },
  ]);

  assert.deepEqual(rows(section), [
    ['$.name', '0', '0', '0', '1', '0'],
    ['$.offers items', '0', '0', '0', '1', '0'],
    ['$.offers[*].kind', '0', '0', '0', '1', '0'],
  ]);
});

test("with the scorers' nullIsMissing, as offers scores, a stated null is no value, so its expected leaf is missed, not incorrect", () => {
  const samples = [answered('a', { name: 'Acme' }, { name: null })];

  const asValue = new FieldErrors(new RunLog(info, samples), {
    comparer: new TreeWalk(),
  });
  const asMissing = new FieldErrors(new RunLog(info, samples), {
    comparer: new TreeWalk(),
    nullIsMissing: true,
  });

  assert.deepEqual(rows(asValue), [['$.name', '0', '0', '1', '0', '0']]);
  assert.deepEqual(rows(asMissing), [['$.name', '0', '0', '0', '1', '0']]);
});

test('the answer of each epoch counts', () => {
  const section = fieldErrors([
    answered('a', { name: 'Acme' }, { name: 'Acme' }, { epoch: 0 }),
    answered('a', { name: 'Acme' }, { name: 'Bolt' }, { epoch: 1 }),
  ]);

  assert.deepEqual(
    { rows: rows(section), claim: section.claim },
    {
      rows: [['$.name', '1', '0', '1', '0', '0']],
      claim: '$.name is wrong most often: 1 of 2 (1 incorrect)',
    },
  );
});

void test.each(
  [
    {
      name: 'names the row with the most errors and only its classes with a count',
      samples: [
        answered('a', { a: 'one', b: 'red car' }, { a: 'two', b: 'red bus' }),
        answered('b', { a: 'one', b: 'blue' }, { a: 'one' }),
      ],
      claim: '$.b is wrong most often: 2 of 2 (1 partial, 1 missed)',
    },
    {
      name: 'names the first of two rows with as many errors',
      samples: [answered('a', { a: 'one', b: 'two' }, { a: 'uno', b: 'dos' })],
      claim: '$.a is wrong most often: 1 of 1 (1 incorrect)',
    },
    {
      name: 'names a field that only the answer has',
      samples: [answered('a', { a: 'one' }, { a: 'one', z: 'extra' })],
      claim: '$.z is wrong most often: 1 of 1 (1 spurious)',
    },
    {
      name: 'says so when no field has an error',
      samples: [
        answered(
          'a',
          { a: 'one', offers: [{ kind: 'credit' }] },
          {
            a: 'one',
            offers: [{ kind: 'credit' }],
          },
        ),
      ],
      claim: 'Every field of every answer is right',
    },
  ],
  ({ name, samples, claim }) =>
    test(`the claim ${name}`, () => {
      const section = fieldErrors(samples);

      assert.equal(section.claim, claim);
    }),
);

test('a FieldErrors section of a log with no samples is a RangeError', () => {
  assert.throws(() => fieldErrors([]), {
    name: 'RangeError',
    message: 'A FieldErrors section needs a sample to compare',
  });
});

test('a FieldErrors section renders as HTML and Markdown with its claim and with no NaN', () => {
  const section = fieldErrors([
    answered(
      'a',
      { name: 'Acme Corp', offers: [{ kind: 'credit' }] },
      { name: 'Acme Inc', offers: [] },
    ),
  ]);
  const { html, markdown, heading } = render(section);

  assert.deepEqual(
    {
      claim: section.claim,
      html: { claim: html.includes(section.claim), nan: html.includes('NaN') },
      markdown: { heading, nan: markdown.includes('NaN') },
    },
    {
      claim: '$.name is wrong most often: 1 of 1 (1 partial)',
      html: { claim: true, nan: false },
      markdown: { heading: section.claim, nan: false },
    },
  );
});
