import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';
import { defaultRng } from '@zukhruf/random';
import { Holm, Linear, PercentileInterval } from '@zukhruf/statistics';

import {
  PairedBootstrap,
  Ratio,
  RunLog,
  RunPair,
  type Sample,
  Table,
} from '../index.ts';
import {
  HtmlRenderer,
  MarkdownRenderer,
  Page,
  type Score,
  Verdicts,
} from './index.ts';

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

const log = (label: string, samples: Sample<string, null>[]) =>
  new RunLog({ id: label, label, createdAt: new Date(0) }, samples);

const percentile = new PercentileInterval({
  low: 0.025,
  high: 0.975,
  method: new Linear(),
});

// Two tests, a and b, on which each score rises or falls by 0.5 from the
// baseline to the change. A resample of [a, a] moves the score the other way
// (by 1), and a resample of [a, b] gives the observed difference.
const shapes = {
  // a: 1 of 1, then 0 of 1; b: 0 of 3, then 3 of 3. 0.25 → 0.75.
  rises: {
    a: [new Ratio(1, 1), new Ratio(0, 1)],
    b: [new Ratio(0, 3), new Ratio(3, 3)],
  },
  // a: 0 of 1, then 1 of 1; b: 3 of 3, then 0 of 3. 0.75 → 0.25.
  falls: {
    a: [new Ratio(0, 1), new Ratio(1, 1)],
    b: [new Ratio(3, 3), new Ratio(0, 3)],
  },
} as const;

type Shape = keyof typeof shapes;

// The pair of two runs on a and b, with the shape of each score.
const pairOf = (scores: Record<string, Shape>) => {
  const side = (index: 0 | 1, testId: 'a' | 'b') =>
    sample(
      testId,
      Object.fromEntries(
        Object.entries(scores).map(([name, shape]) => [
          name,
          shapes[shape][testId][index],
        ]),
      ),
    );
  return new RunPair(
    log('baseline', [side(0, 'a'), side(0, 'b')]),
    log('change', [side(1, 'a'), side(1, 'b')]),
  );
};

// A paired bootstrap of 100 resamples for each verdict, in order: for the
// score of the i-th verdict, the first against[i] resamples are [a, a] and the
// others [a, b], so its p is 2 · against[i] / 100 (at most 1).
const scripted = (...against: number[]) => {
  const draws = against.flatMap((count) =>
    Array.from({ length: 100 }, (_, resample) =>
      resample < count ? [0, 0] : [0, 1],
    ).flat(),
  );
  return new PairedBootstrap({
    nResamples: 100,
    randomIndex: () => draws.shift() ?? Number.NaN,
    interval: percentile,
  });
};

const table = (section: Verdicts<string, null>) => {
  const [primitive] = section.primitives;
  assert.ok(primitive instanceof Table);
  return primitive;
};

const texts = (section: Verdicts<string, null>) => {
  const { columns, rows } = table(section);
  return { columns, rows: rows.map((cells) => cells.map(({ text }) => text)) };
};

const higher = (name: string): Score => ({ name, higherIsBetter: true });

test('each row gives Run#total of each run and PairedBootstrap.verdict on the same runs, drawn in the order of the scores, with the primary score first', () => {
  const ratios = (recall: Ratio, precision: Ratio, f1: Ratio) => ({
    recall,
    precision,
    f1,
  });
  const pair = new RunPair(
    log('baseline', [
      sample('a', ratios(new Ratio(1, 4), new Ratio(2, 3), new Ratio(1, 2))),
      sample('b', ratios(new Ratio(3, 5), new Ratio(1, 1), new Ratio(0, 1))),
      sample('c', ratios(new Ratio(2, 2), new Ratio(1, 3), new Ratio(2, 3))),
      sample('d', ratios(new Ratio(0, 3), new Ratio(4, 5), new Ratio(1, 1))),
    ]),
    log('change', [
      sample('a', ratios(new Ratio(3, 4), new Ratio(3, 3), new Ratio(2, 2))),
      sample('b', ratios(new Ratio(4, 5), new Ratio(0, 1), new Ratio(1, 1))),
      sample('c', ratios(new Ratio(2, 2), new Ratio(2, 3), new Ratio(3, 3))),
      sample('d', ratios(new Ratio(2, 3), new Ratio(5, 5), new Ratio(0, 1))),
    ]),
  );
  const seeded = () => {
    const generator = defaultRng(11);
    return new PairedBootstrap({
      nResamples: 200,
      randomIndex: (n) => generator.integers(0, n, 1)[0] ?? Number.NaN,
      interval: percentile,
    });
  };
  const expected = seeded();
  const baseline = pair.baseline.run();
  const change = pair.change.run();
  const [recall, precision, f1] = ['recall', 'precision', 'f1'].map((name) =>
    expected.verdict(baseline, change, name, { higherIsBetter: true }),
  );
  assert.ok(recall && precision && f1);
  const [recallHolm, f1Holm] = new Holm().adjust([recall.p, f1.p]);
  const signed = (value: number) =>
    value.toLocaleString('en', {
      signDisplay: 'exceptZero',
      minimumFractionDigits: 3,
      maximumFractionDigits: 3,
    });
  const row = (
    name: string,
    { difference: { observed, low, high }, p }: typeof recall,
    holm: string,
  ) => [
    name,
    baseline.total(name).value.toFixed(3),
    change.total(name).value.toFixed(3),
    `${signed(observed)} [${signed(low)}, ${signed(high)}]`,
    p.toFixed(3),
    holm,
  ];

  const { rows } = texts(
    new Verdicts(pair, {
      scores: [higher('recall'), higher('precision'), higher('f1')],
      primary: 'precision',
      bootstrap: seeded(),
    }),
  );

  assert.deepEqual(
    rows.map((cells) => cells.slice(0, -1)),
    [
      row('precision', precision, '—'),
      row('recall', recall, recallHolm?.toFixed(3) ?? ''),
      row('f1', f1, f1Holm?.toFixed(3) ?? ''),
    ],
  );
});

test('the columns name each number, and the difference is signed with its interval', () => {
  const section = new Verdicts(
    pairOf({ values_f1: 'rises', recall: 'falls' }),
    {
      scores: [higher('values_f1'), higher('recall')],
      primary: 'values_f1',
      bootstrap: scripted(50, 50),
    },
  );

  assert.deepEqual(texts(section), {
    columns: [
      'score',
      'baseline',
      'change',
      'difference',
      'p',
      'Holm p',
      'verdict',
    ],
    rows: [
      [
        'values_f1',
        '0.250',
        '0.750',
        '+0.500 [-1.000, +0.500]',
        '1.000',
        '—',
        'no difference',
      ],
      [
        'recall',
        '0.750',
        '0.250',
        '-0.500 [-0.500, +1.000]',
        '1.000',
        '1.000',
        'no difference',
      ],
    ],
  });
});

void test.each(
  [
    {
      name: 'a p of 0.04 among two scores is 0.08 after Holm, so it is not beyond chance',
      against: [2, 2, 10],
      expected: [
        ['primary', '0.040', '—', 'better'],
        ['recall', '0.040', '0.080', 'no difference'],
        ['precision', '0.200', '0.200', 'no difference'],
      ],
    },
    {
      name: 'a p of 0.02 among two scores is 0.04 after Holm, so it stays beyond chance',
      against: [2, 1, 10],
      expected: [
        ['primary', '0.040', '—', 'better'],
        ['recall', '0.020', '0.040', 'better'],
        ['precision', '0.200', '0.200', 'no difference'],
      ],
    },
  ],
  ({ name, against, expected }) =>
    test(`the primary score is tested alone and Holm corrects the others: ${name}`, () => {
      const section = new Verdicts(
        pairOf({ primary: 'rises', recall: 'rises', precision: 'rises' }),
        {
          scores: [higher('primary'), higher('recall'), higher('precision')],
          primary: 'primary',
          bootstrap: scripted(...against),
        },
      );

      assert.deepEqual(
        texts(section).rows.map(([score, , , , p, holm, verdict]) => [
          score,
          p,
          holm,
          verdict,
        ]),
        expected,
      );
    }),
);

void test.each(
  [
    {
      shape: 'rises',
      higherIsBetter: true,
      against: 0,
      verdict: 'better',
      tone: 'good',
    },
    {
      shape: 'falls',
      higherIsBetter: true,
      against: 0,
      verdict: 'worse',
      tone: 'bad',
    },
    {
      shape: 'rises',
      higherIsBetter: false,
      against: 0,
      verdict: 'worse',
      tone: 'bad',
    },
    {
      shape: 'falls',
      higherIsBetter: false,
      against: 0,
      verdict: 'better',
      tone: 'good',
    },
    {
      shape: 'rises',
      higherIsBetter: true,
      against: 50,
      verdict: 'no difference',
      tone: 'neutral',
    },
    {
      shape: 'falls',
      higherIsBetter: false,
      against: 50,
      verdict: 'no difference',
      tone: 'neutral',
    },
  ] as const,
  ({ shape, higherIsBetter, against, verdict, tone }) =>
    test(`a score that ${shape}, better ${higherIsBetter ? 'higher' : 'lower'}, with a p of ${(2 * against) / 100}, reads ${verdict} with the tone ${tone}`, () => {
      const section = new Verdicts(pairOf({ cost: shape }), {
        scores: [{ name: 'cost', higherIsBetter }],
        primary: 'cost',
        bootstrap: scripted(against),
      });

      const [row] = table(section).rows;
      assert.deepEqual(row?.at(-1), { text: verdict, tone });
    }),
);

void test.each(
  [
    {
      name: 'a primary score better beyond chance, with no other score',
      scores: { values_f1: 'rises' },
      against: [0],
      claim: 'values_f1 is better beyond chance: +0.500 [+0.500, +0.500]',
    },
    {
      name: 'a primary score worse beyond chance, and two other scores',
      scores: { values_f1: 'falls', recall: 'rises', precision: 'rises' },
      against: [0, 0, 50],
      claim:
        'values_f1 is worse beyond chance: -0.500 [-0.500, -0.500]; of the other 2 scores, after Holm, 1 better and 0 worse',
    },
    {
      name: 'a primary score with no difference, and one other score',
      scores: { values_f1: 'rises', recall: 'falls' },
      against: [50, 0],
      claim:
        'No difference beyond chance on values_f1 (+0.500 [-1.000, +0.500]); of the other 1 score, after Holm, 0 better and 1 worse',
    },
  ] as const,
  ({ name, scores, against, claim }) =>
    test(`the claim leads with the primary score: ${name}`, () => {
      const section = new Verdicts(pairOf(scores), {
        scores: Object.keys(scores).map(higher),
        primary: 'values_f1',
        bootstrap: scripted(...against),
      });

      assert.equal(section.claim, claim);
    }),
);

test('a primary score that is not one of the scores is a RangeError that names the scores', () => {
  assert.throws(
    () =>
      new Verdicts(pairOf({ recall: 'rises', precision: 'rises' }), {
        scores: [higher('recall'), higher('precision')],
        primary: 'values_f1',
        bootstrap: scripted(0, 0),
      }),
    {
      name: 'RangeError',
      message:
        'The primary score is one of the scores, and "values_f1" is not: recall, precision',
    },
  );
});

test('verdicts render as HTML and Markdown with their claim and with no NaN', () => {
  const section = new Verdicts(
    pairOf({ values_f1: 'rises', recall: 'falls' }),
    {
      scores: [higher('values_f1'), { name: 'recall', higherIsBetter: false }],
      primary: 'values_f1',
      bootstrap: scripted(0, 50),
    },
  );
  const page = new Page('Haiku and DeepSeek', [section]);

  const html = new HtmlRenderer().render(page);
  const markdown = new MarkdownRenderer().render(page);

  assert.deepEqual(
    {
      html: { claim: html.includes(section.claim), nan: html.includes('NaN') },
      markdown: {
        // remark escapes the bracket that would start a link.
        claim: markdown.includes(
          '## values_f1 is better beyond chance: +0.500 \\[+0.500, +0.500]; of the other 1 score, after Holm, 0 better and 0 worse',
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
