import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ConfigCase,
  JsonSchema,
  JsonValue,
  PathMatches,
  Precision,
  Recall,
  ScorerSet,
} from '../index.ts';

test('Recall and Precision of PathMatches count the leaf paths that both values have, whatever their values, of the expected paths and of the stated paths; a path that only one value has is no hit', () => {
  const scorer = new ScorerSet({
    recall: new Recall(new PathMatches()),
    precision: new Precision(new PathMatches()),
  });
  const testCase = new ConfigCase({
    schema: new JsonSchema(JsonValue.from({ type: 'object' }), { draft: '7' }),
  }).from({ expected: { a: 1, b: { c: 2 }, d: [3] } });

  const scorecard = scorer.score(
    { a: 'other', b: { c: 2 }, d: 3, e: 4 },
    testCase,
  );

  assert.deepEqual(
    ['recall', 'precision'].map((name) => {
      const ratio = scorecard.ratios.get(name);
      return [ratio?.part, ratio?.whole];
    }),
    [
      [2, 3],
      [2, 4],
    ],
  );
});
