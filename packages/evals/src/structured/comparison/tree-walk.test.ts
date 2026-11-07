import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ConfigCase, JsonValue, TreeWalk } from '../index.ts';

// JSON.stringify gives {} for a Map and a Set, so a stated dict of the
// package's own JsonData would be scored as an empty answer.
test('a stated Map or Set is refused with a TypeError that names what to give, and a JsonValue of the same data is compared', () => {
  const testCase = new ConfigCase().from({ expected: { a: 1 } });
  const data = JsonValue.from({ a: 1 }).value;
  const walk = new TreeWalk();

  const refusals = [data, new Set([1])].map((stated) => () => {
    walk.compare(stated, testCase);
  });
  const agreeing = walk
    .compare(new JsonValue(data), testCase)
    .leaves()
    .filter((pair) => pair.agrees === true).length;

  for (const refusal of refusals)
    assert.throws(
      refusal,
      (error: unknown) =>
        error instanceof TypeError &&
        /JSON text, a JsonValue or a plain JavaScript value/u.test(
          error.message,
        ),
    );
  assert.equal(agreeing, 1);
});
