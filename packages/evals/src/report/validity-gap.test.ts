import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';
import { defaultRng } from '@zukhruf/random';
import { Linear, PercentileInterval } from '@zukhruf/statistics';

import { Bootstrap, Ratio, RunLog, type Sample, Table } from '../index.ts';
import { render } from '../testing/render.ts';
import { type Score, ValidityGap } from './index.ts';
import { measure } from './part.ts';

const info = { id: 'eval-1', label: 'model', createdAt: new Date(0) };

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

// The ratio of a gate: 1 of 1 when it held, 0 of 1 when not.
const held = new Ratio(1, 1);
const failed = new Ratio(0, 1);

// A bootstrap of one resample that draws the first test: the interval is the
// value of the first test of the samples it reads.
const firstTest = () =>
  new Bootstrap({
    nResamples: 1,
    randomIndex: () => 0,
    interval: new PercentileInterval({ low: 0, high: 1, method: new Linear() }),
  });

const accuracy: Score = { name: 'accuracy', higherIsBetter: true };

const gap = (samples: Sample<string, null>[], scores: Score[] = [accuracy]) =>
  new ValidityGap(new RunLog(info, samples), {
    validity: 'compliance',
    scores,
    bootstrap: firstTest(),
  });

const table = (section: ValidityGap<string, null>) => {
  const [primitive] = section.primitives;
  assert.ok(primitive instanceof Table);
  return primitive;
};

const texts = (section: ValidityGap<string, null>) => {
  const { columns, rows } = table(section);
  return { columns, rows: rows.map((cells) => cells.map(({ text }) => text)) };
};

test('the rows give the share of valid answers, then each score over all answers and over the valid ones, with the wrong values among the valid', () => {
  const section = gap(
    [
      sample('a', { compliance: held, accuracy: new Ratio(3, 3) }),
      sample('b', { compliance: held, accuracy: new Ratio(1, 2) }),
      // Not valid: its wrong values are not counted among the valid.
      sample('c', { compliance: failed, accuracy: new Ratio(0, 2) }),
      // Valid, with no whole for accuracy: it is not counted either.
      sample('d', { compliance: held, accuracy: new Ratio(0, 0) }),
    ],
    [{ name: 'accuracy', higherIsBetter: true, bar: { atLeast: 0.9 } }],
  );

  assert.deepEqual(
    {
      ...texts(section),
      tones: new Set(
        table(section)
          .rows.flat()
          .map(({ tone }) => tone),
      ),
    },
    {
      columns: ['', 'all answers', 'valid answers', 'wrong among valid'],
      rows: [
        ['valid', '0.750 [1.000, 1.000]', '—', '—'],
        ['accuracy', '0.571 [1.000, 1.000]', '0.800 [1.000, 1.000]', '1 of 2'],
      ],
      tones: new Set(['neutral']),
    },
  );
});

test('a sample whose gate gives no whole is not valid', () => {
  const section = gap([
    sample('a', { compliance: new Ratio(0, 0), accuracy: new Ratio(1, 2) }),
    sample('b', { compliance: held, accuracy: new Ratio(2, 2) }),
  ]);

  // The first test's gate has no whole, so the one resample of [a, a] has no
  // value and the share has no interval (#6267), where Ratio.value would
  // give it [0, 0].
  assert.deepEqual(texts(section).rows, [
    ['valid', '1.000', '—', '—'],
    ['accuracy', '0.750 [0.500, 0.500]', '1.000 [1.000, 1.000]', '0 of 1'],
  ]);
});

test('each score has its own row, in the order of the scores', () => {
  const section = gap(
    [
      sample('a', {
        compliance: held,
        accuracy: new Ratio(1, 2),
        recall: new Ratio(1, 1),
      }),
    ],
    [accuracy, { name: 'recall', higherIsBetter: true }],
  );

  assert.deepEqual(
    texts(section).rows.map(([name, , , wrong]) => [name, wrong]),
    [
      ['valid', '—'],
      ['accuracy', '1 of 1'],
      ['recall', '0 of 1'],
    ],
  );
});

void test.each(
  [
    {
      name: 'no answer is valid',
      samples: [sample('a', { compliance: failed, accuracy: new Ratio(1, 2) })],
      claim: 'No answer is valid by compliance',
    },
    {
      name: 'no valid answer gives the score a whole',
      samples: [
        sample('a', { compliance: held, accuracy: new Ratio(0, 0) }),
        sample('b', { compliance: failed, accuracy: new Ratio(1, 2) }),
      ],
      claim: 'No valid answer by compliance gives accuracy',
    },
    {
      name: 'the one valid answer is right',
      samples: [
        sample('a', { compliance: held, accuracy: new Ratio(2, 2) }),
        sample('b', { compliance: failed, accuracy: new Ratio(1, 2) }),
      ],
      claim: 'The one valid answer has every accuracy value right',
    },
    {
      name: 'every valid answer is right',
      samples: [
        sample('a', { compliance: held, accuracy: new Ratio(2, 2) }),
        sample('b', { compliance: held, accuracy: new Ratio(1, 1) }),
        sample('c', { compliance: failed, accuracy: new Ratio(0, 2) }),
      ],
      claim: 'Every one of the 2 valid answers has every accuracy value right',
    },
    {
      name: 'the one valid answer has a wrong value',
      samples: [
        sample('a', { compliance: held, accuracy: new Ratio(1, 2) }),
        sample('b', { compliance: failed, accuracy: new Ratio(2, 2) }),
      ],
      claim:
        '50% of answers are valid by compliance, and 1 of the 1 valid answer has a wrong accuracy value',
    },
    {
      name: 'one of many valid answers has a wrong value',
      samples: [
        sample('a', { compliance: held, accuracy: new Ratio(1, 2) }),
        sample('b', { compliance: held, accuracy: new Ratio(2, 2) }),
        sample('c', { compliance: failed, accuracy: new Ratio(2, 2) }),
      ],
      claim:
        '66.7% of answers are valid by compliance, and 1 of the 2 valid answers has a wrong accuracy value',
    },
    {
      name: 'many valid answers have a wrong value',
      samples: [
        sample('a', { compliance: held, accuracy: new Ratio(1, 2) }),
        sample('b', { compliance: held, accuracy: new Ratio(0, 2) }),
        sample('c', { compliance: held, accuracy: new Ratio(2, 2) }),
      ],
      claim:
        '100% of answers are valid by compliance, and 2 of the 3 valid answers have a wrong accuracy value',
    },
  ] satisfies {
    name: string;
    samples: Sample<string, null>[];
    claim: string;
  }[],
  ({ name, samples, claim }) =>
    test(`the claim when ${name}`, () => {
      assert.equal(gap(samples).claim, claim);
    }),
);

test('the claim reads the first score only', () => {
  const section = gap(
    [
      sample('a', {
        compliance: held,
        accuracy: new Ratio(2, 2),
        recall: new Ratio(0, 1),
      }),
    ],
    [accuracy, { name: 'recall', higherIsBetter: true }],
  );

  assert.equal(
    section.claim,
    'The one valid answer has every accuracy value right',
  );
});

test('a ValidityGap section with no scores is a RangeError', () => {
  assert.throws(() => gap([sample('a', { compliance: held })], []), {
    name: 'RangeError',
    message: 'A ValidityGap section needs a score to show',
  });
});

void test.each(
  [
    { name: 'validity', validity: 'complaince', score: 'accuracy' },
    { name: 'score', validity: 'compliance', score: 'acuracy' },
  ],
  ({ name, validity, score }) =>
    test(`a ${name} that no sample of the run gives is an error, not a row of dashes`, () => {
      assert.throws(
        () =>
          new ValidityGap(
            new RunLog(info, [
              sample('a', { compliance: held, accuracy: new Ratio(1, 1) }),
            ]),
            {
              validity,
              scores: [{ name: score, higherIsBetter: true }],
              bootstrap: firstTest(),
            },
          ),
        {
          message: `No scorecard of the run gave a ratio named "${name === 'validity' ? validity : score}"`,
        },
      );
    }),
);

test('a ValidityGap section with no valid answer renders as HTML and Markdown with its claim and with no NaN', () => {
  const section = gap([
    sample('a', { compliance: failed, accuracy: new Ratio(1, 2) }),
  ]);
  const { html, markdown, heading } = render(section);

  assert.deepEqual(
    {
      html: { claim: html.includes(section.claim), nan: html.includes('NaN') },
      markdown: { heading, nan: markdown.includes('NaN') },
      row: texts(section).rows[1],
    },
    {
      html: { claim: true, nan: false },
      markdown: { heading: section.claim, nan: false },
      row: ['accuracy', '0.500 [0.500, 0.500]', '—', '0 of 0'],
    },
  );
});

test('a cell whose interval comes from fewer resamples than the bootstrap drew says how many it kept', () => {
  const log = new RunLog(info, [
    sample('a', { compliance: held, accuracy: new Ratio(1, 2) }),
    // No whole for accuracy: a resample that draws only b has no value.
    sample('b', { compliance: held, accuracy: new Ratio(0, 0) }),
    sample('c', { compliance: failed, accuracy: new Ratio(2, 2) }),
  ]);
  const seeded = () => {
    const generator = defaultRng(7);
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
  // The section draws the share, then accuracy over all answers, then over
  // the valid ones; the share's gate has a whole on every test.
  const expected = seeded();
  const valid = log.samples.filter(({ test }) => test !== 'c');
  const [share, all, validOnly] = [
    measure(log, log.samples, 'compliance', expected),
    measure(log, log.samples, 'accuracy', expected),
    measure(log, valid, 'accuracy', expected),
  ].map(({ value, interval }) => ({
    value: value.toFixed(3),
    low: interval?.low.toFixed(3),
    high: interval?.high.toFixed(3),
    resamples: interval?.resamples,
  }));
  assert.ok(share && all && validOnly);

  const section = new ValidityGap(log, {
    validity: 'compliance',
    scores: [accuracy],
    bootstrap: seeded(),
  });

  assert.deepEqual(texts(section).rows, [
    ['valid', `${share.value} [${share.low}, ${share.high}]`, '—', '—'],
    [
      'accuracy',
      `${all.value} [${all.low}, ${all.high}] from ${all.resamples} of 200 resamples`,
      `${validOnly.value} [${validOnly.low}, ${validOnly.high}] from ${validOnly.resamples} of 200 resamples`,
      '1 of 1',
    ],
  ]);
});
