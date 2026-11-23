import assert from 'node:assert/strict';
import { test } from 'node:test';

import { LongContextReorder } from './index.ts';

// A list best first, as a retriever gives it: p1 is the best passage.
const bestFirst = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    passage: {
      id: `p${index + 1}`,
      text: `passage ${index + 1}`,
      source: 'guide',
      seq: index,
      start: 0,
      end: 0,
      metadata: {},
    },
    score: 1 - index / 10,
  }));

const order = (
  results: readonly { readonly passage: { readonly id: string } }[],
) => results.map(({ passage }) => passage.id);

test('the best passages go to the two ends and the worst to the middle, as LangChain reorders them', async () => {
  // Arrange
  const reorder = new LongContextReorder();

  // Act
  const five = await reorder.postprocess(bestFirst(5));
  const four = await reorder.postprocess(bestFirst(4));

  // Assert: LangChain's _litm_reordering reverses the list, then puts the
  // passage at an even position at the front and at an odd one at the back.
  //   five reversed p5 p4 p3 p2 p1:
  //     0 p5 front [p5]; 1 p4 back [p5 p4]; 2 p3 front [p3 p5 p4];
  //     3 p2 back [p3 p5 p4 p2]; 4 p1 front [p1 p3 p5 p4 p2]
  //   four reversed p4 p3 p2 p1:
  //     0 p4 front [p4]; 1 p3 back [p4 p3]; 2 p2 front [p2 p4 p3];
  //     3 p1 back [p2 p4 p3 p1]
  // Haystack's LostInTheMiddleRanker gives p1 p3 p4 p2 for four: the best
  // passage first, not last.
  assert.deepEqual(order(five), ['p1', 'p3', 'p5', 'p4', 'p2']);
  assert.deepEqual(order(four), ['p2', 'p4', 'p3', 'p1']);
});

test('each passage keeps its score after the reorder', async () => {
  // Arrange
  const reorder = new LongContextReorder();

  // Act
  const results = await reorder.postprocess(bestFirst(3));

  // Assert: reversed p3 p2 p1 gives [p1 p3 p2].
  assert.deepEqual(
    results.map(({ passage, score }) => [passage.id, score]),
    [
      ['p1', 1],
      ['p3', 0.8],
      ['p2', 0.9],
    ],
  );
});

test('an empty list stays empty, one passage stays, and two passages swap, as LangChain reorders them', async () => {
  // Arrange
  const reorder = new LongContextReorder();

  // Act
  const none = await reorder.postprocess([]);
  const one = await reorder.postprocess(bestFirst(1));
  const two = await reorder.postprocess(bestFirst(2));

  // Assert: two reversed p2 p1: 0 p2 front [p2]; 1 p1 back [p2 p1].
  assert.deepEqual(order(none), []);
  assert.deepEqual(order(one), ['p1']);
  assert.deepEqual(order(two), ['p2', 'p1']);
});
