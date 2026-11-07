import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SampleAveraged } from '../../index.ts';
import {
  ConfigCase,
  JsonSchema,
  JsonValue,
  ScorerSet,
  TextVarsCase,
  TokenF1,
} from '../index.ts';

const schema = { type: 'object' };

test('TokenF1 gives the token F1 of a leaf with the arithmetic of token_f1: 2·p·r/(p + r) gives 0.33333333333333337 where 2·overlap/(stated + expected) gives 1/3', () => {
  const scorer = new ScorerSet({
    f1: new TokenF1({ whenNoWords: 1, absentAs: null }),
  });

  const scorecard = scorer.score(
    { a: 'x b c d e' },
    new ConfigCase({
      schema: new JsonSchema(JsonValue.from(schema), { draft: '7' }),
    }).from({ expected: { a: 'X' } }),
  );

  const ratio = scorecard.ratios.get('f1');
  assert.deepEqual([ratio?.part, ratio?.whole], [0.33333333333333337, 1]);
});

test("TokenF1 gives the sum of the token F1 of each expected leaf over the expected leaves, and splits words as Python's \\w does: a letter outside ASCII is part of a word, so café is not caf and éthe holds no article", () => {
  const scorer = new ScorerSet({
    f1: new TokenF1({ whenNoWords: 1, absentAs: null }),
  });

  const scorecard = scorer.score(
    { a: 'caf', b: 'é', c: 'x', d: 'y' },
    new ConfigCase({
      schema: new JsonSchema(JsonValue.from(schema), { draft: '7' }),
    }).from({ expected: { a: 'café', b: 'éthe', c: 'x' } }),
  );

  const ratio = scorecard.ratios.get('f1');
  assert.deepEqual([ratio?.part, ratio?.whole], [1, 3]);
});

test('TokenF1 reads words as normalize_answer does, with no NFKC: lower case, punctuation as spaces, a full-width letter is not its ASCII letter, and a float is its Python str()', () => {
  const scorer = new ScorerSet({
    f1: new TokenF1({ whenNoWords: 1, absentAs: null }),
  });

  const scorecard = scorer.score(
    '{"a": "HELLO,world", "b": "a", "c": 1.0}',
    new TextVarsCase({
      schema: (value) => new JsonSchema(value, { draft: '7' }),
    }).from({
      expected: '{"a": "hello world", "b": "\u{FF41}", "c": "1.0"}',
      schema,
    }),
  );

  const ratio = scorecard.ratios.get('f1');
  assert.deepEqual([ratio?.part, ratio?.whole], [2, 3]);
});

test('an expected value that has no leaf gives a ratio with the whole 0, which SampleAveraged gives the whenEmpty of its caller', () => {
  const scorer = new ScorerSet({
    quarter: new SampleAveraged(
      new TokenF1({ whenNoWords: 1, absentAs: null }),
      { whenEmpty: 0.25 },
    ),
    half: new SampleAveraged(new TokenF1({ whenNoWords: 1, absentAs: null }), {
      whenEmpty: 0.5,
    }),
  });

  const scorecard = scorer.score(
    { a: 'x' },
    new ConfigCase({
      schema: new JsonSchema(JsonValue.from(schema), { draft: '7' }),
    }).from({ expected: { offers: [] } }),
  );

  assert.deepEqual(
    [
      scorecard.ratios.get('quarter')?.value,
      scorecard.ratios.get('half')?.value,
    ],
    [0.25, 0.5],
  );
});

test('TokenF1 gives the whenNoWords of its caller for a leaf where neither value has a word', () => {
  const scorer = new ScorerSet({
    quarter: new TokenF1({ whenNoWords: 0.25, absentAs: null }),
    half: new TokenF1({ whenNoWords: 0.5, absentAs: null }),
  });

  const scorecard = scorer.score(
    { a: '!', b: 'y' },
    new ConfigCase({
      schema: new JsonSchema(JsonValue.from(schema), { draft: '7' }),
    }).from({ expected: { a: 'The', b: 'y' } }),
  );

  assert.deepEqual(
    [
      scorecard.ratios.get('quarter')?.value,
      scorecard.ratios.get('half')?.value,
    ],
    [(0.25 + 1) / 2, (0.5 + 1) / 2],
  );
});

test('TokenF1 reads a path that the stated value does not have as the absentAs of its caller, and a stated null as null', () => {
  const scorer = new ScorerSet({
    none: new TokenF1({ whenNoWords: 1, absentAs: null }),
    word: new TokenF1({ whenNoWords: 1, absentAs: 'x' }),
  });

  const scorecards = [
    scorer.score(
      { b: 'z' },
      new ConfigCase({
        schema: new JsonSchema(JsonValue.from(schema), { draft: '7' }),
      }).from({ expected: { a: 'x y', b: 'z' } }),
    ),
    scorer.score(
      { a: null },
      new ConfigCase({
        schema: new JsonSchema(JsonValue.from(schema), { draft: '7' }),
      }).from({ expected: { a: null } }),
    ),
    scorer.score(
      { a: null },
      new ConfigCase({
        schema: new JsonSchema(JsonValue.from(schema), { draft: '7' }),
      }).from({ expected: { a: 'null' } }),
    ),
  ];

  assert.deepEqual(
    scorecards.map((scorecard) => [
      scorecard.ratios.get('none')?.value,
      scorecard.ratios.get('word')?.value,
    ]),
    [
      [0.5, (2 / 3 + 1) / 2],
      [1, 1],
      [1, 1],
    ],
  );
});

test('the empty-case values of TokenF1 and SampleAveraged are required: the typecheck of the tests fails when one of them is optional', () => {
  type TokenOptions = ConstructorParameters<typeof TokenF1>[0];
  type AverageOptions = ConstructorParameters<typeof SampleAveraged>[1];
  const tokenRequired: [TokenOptions] extends [
    Required<Pick<TokenOptions, 'whenNoWords' | 'absentAs'>>,
  ]
    ? true
    : false = true;
  const averageRequired: [AverageOptions] extends [Required<AverageOptions>]
    ? true
    : false = true;

  assert.deepEqual([tokenRequired, averageRequired], [true, true]);
});
