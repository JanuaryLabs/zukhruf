import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import { Note, RunLog, type Sample, ValuePairs } from '../../index.ts';
import { HtmlRenderer, MarkdownRenderer, Page } from '../../report/index.ts';
import {
  ByBestMatch,
  Case,
  ComparisonSpec,
  FieldDiff,
  JsonValue,
  TreeWalk,
} from '../index.ts';

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

const fieldDiff = (samples: readonly Sample<unknown, Case>[], worst = 20) =>
  new FieldDiff(new RunLog(info, samples), {
    comparer: new TreeWalk(),
    worst,
  });

// The value pairs of a section, each as its title and pairs.
const shown = (section: FieldDiff<Case>) =>
  section.primitives.map((primitive) => {
    assert.ok(primitive instanceof ValuePairs);
    return { title: primitive.title, pairs: primitive.pairs };
  });

void test.each(
  [
    {
      name: 'agree when the comparator agrees',
      expected: { size: 5000, name: 'x' },
      answer: { size: 5000, name: 'y' },
      pair: { path: '$.size', mark: 'agree', expected: '5000', actual: '5000' },
    },
    {
      name: 'near when partial: the two sides disagree and share a word',
      expected: { name: 'Acme Corp' },
      answer: { name: 'ACME, Inc.' },
      pair: {
        path: '$.name',
        mark: 'near',
        expected: 'Acme Corp',
        actual: 'ACME, Inc.',
      },
    },
    {
      name: 'disagree when incorrect: the two sides share no word',
      expected: { size: 5000 },
      answer: { size: 2500 },
      pair: {
        path: '$.size',
        mark: 'disagree',
        expected: '5000',
        actual: '2500',
      },
    },
    {
      name: 'only-expected when missed',
      expected: { gone: 'x' },
      answer: {},
      pair: { path: '$.gone', mark: 'only-expected', expected: 'x' },
    },
    {
      name: 'only-actual when spurious',
      expected: {},
      answer: { extra: true },
      pair: { path: '$.extra', mark: 'only-actual', actual: 'true' },
    },
  ],
  ({ name, expected, answer, pair }) =>
    test(`a leaf is ${name}`, () => {
      const section = fieldDiff([answered('a', expected, answer)]);

      assert.deepEqual(shown(section)[0]?.pairs[0], pair);
    }),
);

test('each leaf is a pair at its path with positions, in the order of the walk, the expected item beside the stated item that the alignment of the scorers paired with it and an unpaired item on its own side', () => {
  const samples = [
    answered(
      'a',
      {
        name: 'Acme',
        offers: [
          { kind: 'credit', amount: 100 },
          { kind: 'grant', amount: 200 },
        ],
      },
      {
        name: 'Acme',
        offers: [
          { kind: 'grant', amount: 250 },
          { kind: 'perk', amount: null },
        ],
      },
    ),
  ];

  const section = new FieldDiff(new RunLog(info, samples), {
    comparer: new TreeWalk(
      new ComparisonSpec({ arrays: { '$.offers': new ByBestMatch() } }),
    ),
    worst: 20,
  });

  assert.deepEqual(shown(section), [
    {
      title: 'a',
      pairs: [
        { path: '$.name', mark: 'agree', expected: 'Acme', actual: 'Acme' },
        { path: '$.offers[0].kind', mark: 'only-expected', expected: 'credit' },
        { path: '$.offers[0].amount', mark: 'only-expected', expected: '100' },
        {
          path: '$.offers[1].kind',
          mark: 'agree',
          expected: 'grant',
          actual: 'grant',
        },
        {
          path: '$.offers[1].amount',
          mark: 'disagree',
          expected: '200',
          actual: '250',
        },
        { path: '$.offers[1].kind', mark: 'only-actual', actual: 'perk' },
        { path: '$.offers[1].amount', mark: 'only-actual', actual: 'null' },
      ],
    },
  ]);
});

test('the answers come most errors first, ties in the order of the samples, with no answer that has no error, and at most `worst` of them', () => {
  const samples = [
    answered('one-error', { a: 'x', b: 'y' }, { a: 'x', b: 'z' }),
    answered('right', { a: 'x' }, { a: 'x' }),
    answered('two-errors', { a: 'x', b: 'y' }, { a: 'q', b: 'z' }),
    answered('one-error-too', { a: 'x' }, { a: 'w' }),
  ];

  const titles = (worst: number) =>
    shown(fieldDiff(samples, worst)).map(({ title }) => title);

  assert.deepEqual(
    { all: titles(20), two: titles(2) },
    {
      all: ['two-errors', 'one-error', 'one-error-too'],
      two: ['two-errors', 'one-error'],
    },
  );
});

void test.each(
  [
    {
      name: 'with one epoch of each test, the title is the test',
      samples: [
        answered('a', { a: 'x' }, { a: 'y' }),
        answered('b', { a: 'x' }, { a: 'y' }),
      ],
      titles: ['a', 'b'],
    },
    {
      name: 'with several epochs of a test, each title names its epoch',
      samples: [
        answered('a', { a: 'x' }, { a: 'y' }, { epoch: 0 }),
        answered('a', { a: 'x' }, { a: 'z' }, { epoch: 1 }),
        answered('b', { a: 'x' }, { a: 'y' }, { epoch: 0 }),
      ],
      titles: ['a · epoch 0', 'a · epoch 1', 'b · epoch 0'],
    },
  ],
  ({ name, samples, titles }) =>
    test(name, () => {
      const section = fieldDiff(samples);

      assert.deepEqual(
        shown(section).map(({ title }) => title),
        titles,
      );
    }),
);

test("with the scorers' nullIsMissing, as offers scores, a stated null is no value, so its expected leaf is only-expected, not disagree", () => {
  const samples = [answered('a', { name: 'Acme' }, { name: null })];

  const asValue = new FieldDiff(new RunLog(info, samples), {
    comparer: new TreeWalk(),
    worst: 20,
  });
  const asMissing = new FieldDiff(new RunLog(info, samples), {
    comparer: new TreeWalk(),
    nullIsMissing: true,
    worst: 20,
  });

  assert.deepEqual(
    {
      asValue: shown(asValue)[0]?.pairs,
      asMissing: shown(asMissing)[0]?.pairs,
    },
    {
      asValue: [
        { path: '$.name', mark: 'disagree', expected: 'Acme', actual: 'null' },
      ],
      asMissing: [{ path: '$.name', mark: 'only-expected', expected: 'Acme' }],
    },
  );
});

void test.each(
  [
    {
      name: 'counts the answers with a field wrong and names the one with the most, with its errors and leaves',
      samples: [
        answered('a', { a: 'x', b: 'y' }, { a: 'x', b: 'z' }),
        answered('b', { a: 'x', b: 'y', c: 'v' }, { a: 'q', b: 'z', c: 'v' }),
        answered('c', { a: 'x' }, { a: 'x' }),
      ],
      claim: '2 of 3 answers have a field wrong; b has the most, 2 of 3 leaves',
    },
    {
      name: 'says has for one answer with a field wrong',
      samples: [
        answered('a', { a: 'x' }, { a: 'y' }),
        answered('b', { a: 'x' }, { a: 'x' }),
      ],
      claim: '1 of 2 answers has a field wrong; a has the most, 1 of 1 leaf',
    },
    {
      name: 'says answer for a log of one answer',
      samples: [answered('a', { a: 'x', b: 'y' }, { a: 'x', b: 'z' })],
      claim: '1 of 1 answer has a field wrong; a has the most, 1 of 2 leaves',
    },
    {
      name: 'names the shown title, with its epoch',
      samples: [
        answered('a', { a: 'x' }, { a: 'x' }, { epoch: 0 }),
        answered('a', { a: 'x' }, { a: 'y' }, { epoch: 1 }),
      ],
      claim:
        '1 of 2 answers has a field wrong; a · epoch 1 has the most, 1 of 1 leaf',
    },
    {
      name: 'says so when no answer has an error',
      samples: [answered('a', { a: 'x' }, { a: 'x' })],
      claim: 'Every answer has every field right',
    },
  ],
  ({ name, samples, claim }) =>
    test(`the claim ${name}`, () => {
      const section = fieldDiff(samples);

      assert.equal(section.claim, claim);
    }),
);

test('with no answer that has an error, the one primitive is a note', () => {
  const section = fieldDiff([answered('a', { a: 'x' }, { a: 'x' })]);

  assert.deepEqual(section.primitives, [
    new Note('No answer has a field to show'),
  ]);
});

void test.each(
  [
    {
      name: 'a log with no samples',
      samples: [],
      worst: 20,
      message: 'A FieldDiff section needs a sample to compare',
    },
    {
      name: 'a worst of 0',
      samples: [answered('a', { a: 'x' }, { a: 'y' })],
      worst: 0,
      message:
        'A FieldDiff section shows a positive whole number of answers, not 0',
    },
    {
      name: 'a worst that is not a whole number',
      samples: [answered('a', { a: 'x' }, { a: 'y' })],
      worst: 1.5,
      message:
        'A FieldDiff section shows a positive whole number of answers, not 1.5',
    },
  ],
  ({ name, samples, worst, message }) =>
    test(`a FieldDiff section of ${name} is a RangeError`, () => {
      assert.throws(() => fieldDiff(samples, worst), {
        name: 'RangeError',
        message,
      });
    }),
);

test('a FieldDiff section renders as HTML and Markdown with its claim and with no NaN', () => {
  const section = fieldDiff([
    answered(
      'a',
      { name: 'Acme Corp', offers: [{ kind: 'credit' }] },
      { name: 'Acme Inc', offers: [] },
    ),
  ]);
  const report = new Page('offers', [section]);

  const html = new HtmlRenderer().render(report);
  const markdown = new MarkdownRenderer().render(report);

  assert.deepEqual(
    {
      claim: section.claim,
      html: { claim: html.includes(section.claim), nan: html.includes('NaN') },
      markdown: {
        claim: markdown.includes(`## ${section.claim}`),
        nan: markdown.includes('NaN'),
      },
    },
    {
      claim: '1 of 1 answer has a field wrong; a has the most, 2 of 2 leaves',
      html: { claim: true, nan: false },
      markdown: { claim: true, nan: false },
    },
  );
});
