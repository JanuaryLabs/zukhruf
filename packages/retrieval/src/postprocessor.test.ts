import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Collapse, LongContextReorder } from './index.ts';

test('an aborted signal rejects a LongContextReorder and a Collapse with its reason, as every postprocessor obeys the port', async () => {
  // Arrange
  const passages = [
    {
      passage: {
        id: 'a',
        text: 'a',
        source: 'guide',
        seq: 0,
        start: 0,
        end: 1,
        metadata: {},
      },
      score: 0.9,
    },
  ];
  const reason = new Error('the caller left');
  const signal = AbortSignal.abort(reason);
  const settled = (call: Promise<unknown>) =>
    call.then(
      () => 'answered',
      (rejection: unknown) => rejection,
    );

  // Act
  const outcomes = await Promise.all([
    settled(new LongContextReorder().postprocess(passages, 'q', { signal })),
    settled(new Collapse().postprocess(passages, 'q', { signal })),
  ]);

  // Assert
  assert.deepEqual(outcomes, [reason, reason]);
});
