import assert from 'node:assert/strict';
import { test } from 'node:test';

import { F1, Precision, Recall, ScorerSet } from '../../index.ts';
import { ScorerAssertion } from '../../promptfoo/index.ts';
import {
  ByBestMatch,
  ByPosition,
  ComparisonSpec,
  ConfigCase,
  ItemMatches,
  JsonSchema,
  JsonValue,
  NormalizedText,
  NumberWithin,
  PythonEquality,
  TextVarsCase,
  TokenOverlapAtLeast,
  TreeWalk,
  TypePrecision,
  ValueMatches,
} from '../index.ts';

// The alignment cases of the records engine (record-scorer.test.ts), ported to
// the comparison core: a ComparisonSpec sets the alignment of each array, the
// comparators and the excluded fields (ADR 0011).

test('an array that the spec does not name pairs by position, as ByPosition does', () => {
  const recall = (spec: ComparisonSpec) =>
    new ScorerSet(
      { recall: new Recall(new ValueMatches()) },
      { comparer: new TreeWalk(spec) },
    )
      .score(
        { xs: ['b', 'a'] },
        new ConfigCase({
          schema: new JsonSchema(JsonValue.from({}), { draft: '7' }),
        }).from({ expected: { xs: ['a', 'b'] } }),
      )
      .ratios.get('recall');

  const ratios = [
    new ComparisonSpec(),
    new ComparisonSpec({ arrays: { '$.xs': new ByPosition() } }),
    new ComparisonSpec({ arrays: { '$.xs': new ByBestMatch() } }),
  ].map((spec) => {
    const ratio = recall(spec);
    return [ratio?.part, ratio?.whole];
  });

  assert.deepEqual(ratios, [
    [0, 2],
    [0, 2],
    [2, 2],
  ]);
});

test('ByBestMatch pairs a reordered list item by item, so each value and each item has its pair; by position only the middle item agrees', () => {
  const expected = {
    offers: [
      { kind: 'a', amount: 1 },
      { kind: 'b', amount: 2 },
      { kind: 'c', amount: 3 },
    ],
  };
  const scorers = {
    'value precision': new Precision(new ValueMatches()),
    'value recall': new Recall(new ValueMatches()),
    'item precision': new Precision(new ItemMatches()),
    'item recall': new Recall(new ItemMatches()),
  };
  const score = (spec: ComparisonSpec) => {
    const scorecard = new ScorerSet(scorers, {
      comparer: new TreeWalk(spec),
    }).score(
      { offers: [...expected.offers].reverse() },
      new ConfigCase({
        schema: new JsonSchema(JsonValue.from({}), { draft: '7' }),
      }).from({ expected: expected }),
    );
    return [...scorecard.ratios].map(([label, ratio]) => [
      label,
      ratio.part,
      ratio.whole,
    ]);
  };

  const bestMatch = score(
    new ComparisonSpec({ arrays: { '$.offers': new ByBestMatch() } }),
  );
  const byPosition = score(new ComparisonSpec());

  assert.deepEqual(bestMatch, [
    ['value precision', 6, 6],
    ['value recall', 6, 6],
    ['item precision', 3, 3],
    ['item recall', 3, 3],
  ]);
  assert.deepEqual(byPosition[1], ['value recall', 2, 6]);
});

test('ByBestMatch takes the pairing with the most agreeing leaves, where pairing each stated item with its best match first would leave one unpaired', () => {
  const scorer = new ScorerSet(
    {
      'item recall': new Recall(new ItemMatches()),
      'value recall': new Recall(new ValueMatches()),
    },
    {
      comparer: new TreeWalk(
        new ComparisonSpec({ arrays: { '$.xs': new ByBestMatch() } }),
      ),
    },
  );
  const expected = {
    xs: [
      { f1: 1, f2: 1, f3: 1, f4: 0, f5: 0 },
      { f1: 0, f2: 0, f3: 0, f4: 2, f5: 2 },
    ],
  };

  const scorecard = scorer.score(
    {
      xs: [
        { f1: 1, f2: 1, f3: 1, f4: 2, f5: 2 },
        { f1: 1, f2: 1, f3: 9, f4: 9, f5: 9 },
      ],
    },
    new ConfigCase({
      schema: new JsonSchema(JsonValue.from({}), { draft: '7' }),
    }).from({ expected: expected }),
  );

  const items = scorecard.ratios.get('item recall');
  const values = scorecard.ratios.get('value recall');
  assert.deepEqual(
    [items?.part, items?.whole, values?.part, values?.whole],
    [2, 2, 4, 10],
  );
});

test('a match gets the stated item first and the expected item second, as JSON data; a pair that it forbids leaves both items unpaired, even when their leaves agree', () => {
  const sameOffer = {
    canPair: (stated: unknown, expected: unknown) =>
      stated instanceof Map &&
      expected instanceof Map &&
      stated.get('id') === 1n &&
      expected.get('ref') === 1n,
  };
  const scorer = new ScorerSet(
    {
      'item recall': new Recall(new ItemMatches()),
      'item precision': new Precision(new ItemMatches()),
    },
    {
      comparer: new TreeWalk(
        new ComparisonSpec({
          arrays: { '$.xs': new ByBestMatch(sameOffer) },
        }),
      ),
    },
  );
  const testCase = new ConfigCase({
    schema: new JsonSchema(JsonValue.from({}), { draft: '7' }),
  }).from({ expected: { xs: [{ ref: 1, v: 'a' }] } });

  const ratios = [
    { id: 1, v: 'a' },
    { id: 2, v: 'a' },
  ].map((item) => {
    const scorecard = scorer.score({ xs: [item, { id: 3 }] }, testCase);
    return ['item recall', 'item precision'].map((label) => {
      const ratio = scorecard.ratios.get(label);
      return [ratio?.part, ratio?.whole];
    });
  });

  assert.deepEqual(ratios, [
    [
      [1, 1],
      [1, 2],
    ],
    [
      [0, 1],
      [0, 2],
    ],
  ]);
});

test('without a match, ByBestMatch leaves items that agree on nothing unpaired', () => {
  const scorer = new ScorerSet(
    {
      'item recall': new Recall(new ItemMatches()),
      'item precision': new Precision(new ItemMatches()),
    },
    {
      comparer: new TreeWalk(
        new ComparisonSpec({ arrays: { '$.xs': new ByBestMatch() } }),
      ),
    },
  );

  const scorecard = scorer.score(
    { xs: [{ v: 'b' }, { v: 'c' }] },
    new ConfigCase({
      schema: new JsonSchema(JsonValue.from({}), { draft: '7' }),
    }).from({ expected: { xs: [{ v: 'a' }] } }),
  );

  const ratios = ['item recall', 'item precision'].map((label) => {
    const ratio = scorecard.ratios.get(label);
    return [ratio?.part, ratio?.whole];
  });
  assert.deepEqual(ratios, [
    [0, 1],
    [0, 2],
  ]);
});

test('ItemMatches adds the items of every array: an expected item without a pair in one array, and a stated array that the expected value does not have', () => {
  const scorer = new ScorerSet(
    {
      'item recall': new Recall(new ItemMatches()),
      'item precision': new Precision(new ItemMatches()),
    },
    {
      comparer: new TreeWalk(
        new ComparisonSpec({
          arrays: { '$.tags': new ByBestMatch(), '$.notes': new ByBestMatch() },
        }),
      ),
    },
  );

  const scorecard = scorer.score(
    { tags: [{ name: 'a' }], notes: [], extra: ['x'] },
    new ConfigCase({
      schema: new JsonSchema(JsonValue.from({}), { draft: '7' }),
    }).from({ expected: { tags: [{ name: 'a' }], notes: [{}, {}] } }),
  );

  const ratios = ['item recall', 'item precision'].map((label) => {
    const ratio = scorecard.ratios.get(label);
    return [ratio?.part, ratio?.whole];
  });
  assert.deepEqual(ratios, [
    [1, 3],
    [1, 2],
  ]);
});

test('Precision, Recall and F1 of ItemMatches count the paired items of the stated items, of the expected items, and as 2·paired of stated + expected; a nested array pairs by the alignment of its own field', () => {
  const scorers = {
    'item precision': new Precision(new ItemMatches()),
    'item recall': new Recall(new ItemMatches()),
    'item f1': new F1(new ItemMatches()),
    'value recall': new Recall(new ValueMatches()),
  };
  const score = (spec: ComparisonSpec) => {
    const scorecard = new ScorerSet(scorers, {
      comparer: new TreeWalk(spec),
    }).score(
      { xs: [{ id: 1, ys: ['b', 'a', 'c'] }] },
      new ConfigCase({
        schema: new JsonSchema(JsonValue.from({}), { draft: '7' }),
      }).from({ expected: { xs: [{ id: 1, ys: ['a', 'b'] }] } }),
    );
    return [...scorecard.ratios].map(([label, ratio]) => [
      label,
      ratio.part,
      ratio.whole,
    ]);
  };

  const nested = score(
    new ComparisonSpec({ arrays: { '$.xs[*].ys': new ByBestMatch() } }),
  );
  const byPosition = score(new ComparisonSpec());

  assert.deepEqual(nested, [
    ['item precision', 3, 4],
    ['item recall', 3, 3],
    ['item f1', 6, 7],
    ['value recall', 3, 3],
  ]);
  assert.deepEqual(byPosition[3], ['value recall', 1, 3]);
});

test('each side of a leaf pair keeps its own path: a stated item that ByBestMatch pairs with an expected item at another position keeps its stated position, and TypePrecision reads the schema there', () => {
  const spec = new ComparisonSpec({ arrays: { '$.xs': new ByBestMatch() } });
  const testCase = new ConfigCase({
    schema: new JsonSchema(
      JsonValue.from({
        type: 'object',
        properties: {
          xs: {
            type: 'array',
            items: [{ type: 'string' }, { type: 'integer' }],
          },
        },
      }),
      { draft: '7' },
    ),
  }).from({ expected: { xs: ['x', 1] } });
  const stated = JsonValue.parse('{"xs": [1, "x"]}');

  const comparison = new TreeWalk(spec).compare(stated, testCase);
  const precision = new TypePrecision().score(comparison);

  assert.deepEqual(
    comparison
      .leaves()
      .map((pair) => [
        pair.expected?.path.steps,
        pair.stated?.path.steps,
        pair.agrees,
      ]),
    [
      [['xs', 0], ['xs', 1], true],
      [['xs', 1], ['xs', 0], true],
    ],
  );
  assert.deepEqual([precision.part, precision.whole], [0, 2]);
});

test('NumberWithin on a field agrees inside its tolerance, an int with a float too, and not outside it; another number field keeps the comparator of the spec', () => {
  const scorer = new ScorerSet(
    { recall: new Recall(new ValueMatches()) },
    {
      comparer: new TreeWalk(
        new ComparisonSpec({
          fields: { '$.offers[*].value.amount': new NumberWithin(0.5) },
        }),
      ),
    },
  );
  const testCase = new ConfigCase({
    schema: new JsonSchema(JsonValue.from({}), { draft: '7' }),
  }).from({ expected: { offers: [{ value: { amount: 10, count: 3 } }] } });

  const values = [10.4, 10.5, 10.6].map(
    (amount) =>
      scorer
        .score({ offers: [{ value: { amount, count: 3.2 } }] }, testCase)
        .ratios.get('recall')?.value,
  );

  assert.deepEqual(values, [0.5, 0.5, 0]);
});

test('NormalizedText on a field agrees across case, spaces and Unicode width, not across a different letter, and not on a value that is not text', () => {
  const scorer = new ScorerSet(
    { recall: new Recall(new ValueMatches()) },
    {
      comparer: new TreeWalk(
        new ComparisonSpec({
          fields: { '$.t': new NormalizedText(), '$.n': new NormalizedText() },
        }),
      ),
    },
  );
  const testCase = new ConfigCase({
    schema: new JsonSchema(JsonValue.from({}), { draft: '7' }),
  }).from({ expected: { t: 'café credits', n: 1 } });

  const values = ['  ＣＡＦÉ   Credits ', 'cafe credits'].map(
    (t) => scorer.score({ t, n: 1 }, testCase).ratios.get('recall')?.value,
  );

  assert.deepEqual(values, [0.5, 0]);
});

test('TokenOverlapAtLeast on a field agrees when the F1 of the words, as SQuAD reads them, reaches its threshold', () => {
  const scorer = new ScorerSet(
    { recall: new Recall(new ValueMatches()) },
    {
      comparer: new TreeWalk(
        new ComparisonSpec({
          fields: {
            '$.t': new TokenOverlapAtLeast((2 * 2) / (2 + 4)),
            '$.u': new TokenOverlapAtLeast(1),
          },
        }),
      ),
    },
  );
  const testCase = new ConfigCase({
    schema: new JsonSchema(JsonValue.from({}), { draft: '7' }),
  }).from({ expected: { t: 'AWS credits for startups', u: 'aws credits' } });

  const values = ['AWS credits', 'AWS'].map(
    (t) =>
      scorer.score({ t, u: 'The AWS credits!' }, testCase).ratios.get('recall')
        ?.value,
  );

  assert.deepEqual(values, [1, 0.5]);
});

test('the agreement that ByBestMatch maximizes uses the comparator of each field: items that agree only inside the tolerance of NumberWithin pair', () => {
  const recall = (spec: ComparisonSpec) => {
    const ratio = new ScorerSet(
      { items: new Recall(new ItemMatches()) },
      { comparer: new TreeWalk(spec) },
    )
      .score(
        { xs: [{ n: 10.2 }] },
        new ConfigCase({
          schema: new JsonSchema(JsonValue.from({}), { draft: '7' }),
        }).from({ expected: { xs: [{ n: 20 }, { n: 10 }] } }),
      )
      .ratios.get('items');
    return [ratio?.part, ratio?.whole];
  };

  const ratios = [
    new ComparisonSpec({ arrays: { '$.xs': new ByBestMatch() } }),
    new ComparisonSpec({
      arrays: { '$.xs': new ByBestMatch() },
      fields: { '$.xs[*].n': new NumberWithin(0.5) },
    }),
  ].map(recall);

  assert.deepEqual(ratios, [
    [0, 2],
    [1, 2],
  ]);
});

test('an excluded field and all its children are out of the leaf pairs, the item pairs, and the agreement that pairs the items', () => {
  const scorers = {
    'value recall': new Recall(new ValueMatches()),
    'item recall': new Recall(new ItemMatches()),
  };
  const score = (spec: ComparisonSpec) => {
    const scorecard = new ScorerSet(scorers, {
      comparer: new TreeWalk(spec),
    }).score(
      { a: 1, notes: { x: 'other' }, xs: [{ k: 'b', note: 'p' }], ys: [] },
      new ConfigCase({
        schema: new JsonSchema(JsonValue.from({}), { draft: '7' }),
      }).from({
        expected: {
          a: 1,
          notes: { x: 'long text' },
          xs: [{ k: 'a', note: 'p' }],
          ys: [1, 2],
        },
      }),
    );
    return [...scorecard.ratios].map(([label, ratio]) => [
      label,
      ratio.part,
      ratio.whole,
    ]);
  };

  const excluded = score(
    new ComparisonSpec({
      arrays: { '$.xs': new ByBestMatch() },
      exclude: ['$.notes', '$.xs[*].note', '$.ys'],
    }),
  );
  const all = score(
    new ComparisonSpec({ arrays: { '$.xs': new ByBestMatch() } }),
  );

  assert.deepEqual(excluded, [
    ['value recall', 1, 2],
    ['item recall', 0, 1],
  ]);
  assert.deepEqual(all, [
    ['value recall', 2, 6],
    ['item recall', 1, 3],
  ]);
});

test('a scorer assertion compares through its spec: true agrees with 1 only with PythonEquality', () => {
  const vars = { expected: '{"a": 1}', schema: { type: 'object' } };
  const assertion = (spec?: ComparisonSpec) =>
    new ScorerAssertion(new Recall(new ValueMatches()), {
      weight: 1,
      threshold: 0,
      comparer: new TreeWalk(spec),
      cases: new TextVarsCase(),
    });

  const values = [
    assertion(),
    assertion(new ComparisonSpec({ comparator: new PythonEquality() })),
  ].map(({ value }) => value('{"a": true}', { vars }));

  assert.deepEqual(values, [0, 1]);
});
