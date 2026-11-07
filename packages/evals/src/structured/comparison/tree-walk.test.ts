import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  ByBestMatch,
  ComparisonSpec,
  ConfigCase,
  type Item,
  JsonValue,
  TreeWalk,
} from '../index.ts';

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

// A consumer explains a stated item with no pair (a wrong offer) by its value,
// so each array of a comparison names its items by path and value.
const shown = (items: readonly Item[]) =>
  items.map(({ path, value }) => [`${path}`, value]);

test('a set array by best match names the stated item that has no pair, with its path and its value, and pairs the others', () => {
  const credits = { kind: 'credits', amount: 5000 };
  const discount = { kind: 'discount', percent: 50 };
  const lookalike = {
    kind: 'credits',
    amount: 100_000,
    quote: 'Startups in our program raised $100,000',
  };
  const walk = new TreeWalk(
    new ComparisonSpec({ arrays: { '$.offers': new ByBestMatch() } }),
  );

  const [offers] = walk
    .compare(
      { offers: [lookalike, credits, discount] },
      new ConfigCase().from({ expected: { offers: [credits, discount] } }),
    )
    .arrays();

  assert.deepEqual(shown(offers?.unpairedStated ?? []), [
    ['$.offers[0]', JsonValue.from(lookalike).value],
  ]);
  assert.deepEqual(shown(offers?.unpairedExpected ?? []), []);
  assert.deepEqual(
    offers?.pairs.map(({ stated, expected }) => [
      shown([stated]),
      shown([expected]),
    ]),
    [
      [
        [['$.offers[1]', JsonValue.from(credits).value]],
        [['$.offers[0]', JsonValue.from(credits).value]],
      ],
      [
        [['$.offers[2]', JsonValue.from(discount).value]],
        [['$.offers[1]', JsonValue.from(discount).value]],
      ],
    ],
  );
  assert.deepEqual(
    [offers?.expected, offers?.stated, offers?.paired],
    [2, 3, 2],
  );
});

test('an array by position leaves the stated item after the last expected item without a pair', () => {
  const [tags] = new TreeWalk()
    .compare(
      { tags: ['a', 'b', 'c'] },
      new ConfigCase().from({ expected: { tags: ['a', 'x'] } }),
    )
    .arrays();

  assert.deepEqual(shown(tags?.unpairedStated ?? []), [['$.tags[2]', 'c']]);
  assert.deepEqual(shown(tags?.unpairedExpected ?? []), []);
  assert.deepEqual(tags?.paired, 2);
});

test('an array by position leaves each expected item after the last stated item without a pair', () => {
  const [tags] = new TreeWalk()
    .compare(
      { tags: ['a'] },
      new ConfigCase().from({ expected: { tags: ['a', 'b', 'c'] } }),
    )
    .arrays();

  assert.deepEqual(shown(tags?.unpairedExpected ?? []), [
    ['$.tags[1]', 'b'],
    ['$.tags[2]', 'c'],
  ]);
  assert.deepEqual(shown(tags?.unpairedStated ?? []), []);
  assert.deepEqual([tags?.expected, tags?.stated, tags?.paired], [3, 1, 1]);
});

test('a stated item that has a pair and a field its expected item lacks is not unpaired', () => {
  const [offers] = new TreeWalk()
    .compare(
      { offers: [{ kind: 'credits', note: 'extra' }] },
      new ConfigCase().from({ expected: { offers: [{ kind: 'credits' }] } }),
    )
    .arrays();

  assert.deepEqual(shown(offers?.unpairedStated ?? []), []);
  assert.deepEqual(offers?.paired, 1);
});

test('when one side has no array at the path, each item of the other side has no pair', () => {
  const walk = new TreeWalk();

  const [statedOnly] = walk
    .compare(
      { offers: ['a', 'b'] },
      new ConfigCase().from({ expected: { offers: null } }),
    )
    .arrays();
  const [expectedOnly] = walk
    .compare({}, new ConfigCase().from({ expected: { offers: ['c'] } }))
    .arrays();

  assert.deepEqual(
    [
      shown(statedOnly?.unpairedStated ?? []),
      shown(statedOnly?.unpairedExpected ?? []),
    ],
    [
      [
        ['$.offers[0]', 'a'],
        ['$.offers[1]', 'b'],
      ],
      [],
    ],
  );
  assert.deepEqual(
    [
      shown(expectedOnly?.unpairedStated ?? []),
      shown(expectedOnly?.unpairedExpected ?? []),
    ],
    [[], [['$.offers[0]', 'c']]],
  );
});

test('an array inside a paired item names its unpaired stated item at the stated position of that item', () => {
  const walk = new TreeWalk(
    new ComparisonSpec({ arrays: { '$.offers': new ByBestMatch() } }),
  );

  const tags = walk
    .compare(
      {
        offers: [
          { kind: 'discount', tags: ['b'] },
          { kind: 'credits', tags: ['a', 'extra'] },
        ],
      },
      new ConfigCase().from({
        expected: {
          offers: [
            { kind: 'credits', tags: ['a'] },
            { kind: 'discount', tags: ['b'] },
          ],
        },
      }),
    )
    .arrays()
    .filter((items) => `${items.field}` === '$.offers[*].tags');

  assert.deepEqual(
    tags.map((items) => shown(items.unpairedStated)),
    [[['$.offers[1].tags[1]', 'extra']], []],
  );
  assert.deepEqual(
    tags.map((items) =>
      items.pairs.map(({ stated, expected }) => [
        `${stated.path}`,
        `${expected.path}`,
      ]),
    ),
    [
      [['$.offers[1].tags[0]', '$.offers[0].tags[0]']],
      [['$.offers[0].tags[0]', '$.offers[1].tags[0]']],
    ],
  );
});
