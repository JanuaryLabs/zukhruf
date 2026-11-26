import assert from 'node:assert/strict';

import { test } from '@zukhruf/parameterized-test';

import { WorkerKind } from './index.ts';

test('a name whose channels would reach 64 bytes throws a RangeError, and the longest name that fits builds', () => {
  // Arrange
  const rules = {
    revision: 1,
    policy: 'exclusive',
    retryLimit: 2,
    expireInSeconds: 120,
  } as const;

  // Act
  const longest = new WorkerKind({ ...rules, name: 'a'.repeat(55) });

  // Assert
  assert.equal(longest.name, 'a'.repeat(55));
  assert.throws(
    () => new WorkerKind({ ...rules, name: 'a'.repeat(56) }),
    RangeError,
  );
  // 28 characters, 56 bytes: the limit counts bytes.
  assert.throws(
    () => new WorkerKind({ ...rules, name: 'é'.repeat(28) }),
    RangeError,
  );
});

test('the queue of a kind is its name and its revision', () => {
  // Arrange
  const vision = new WorkerKind<{ path: string }, { text: string }>({
    name: 'vision',
    revision: 3,
    policy: 'exclusive',
    retryLimit: 2,
    expireInSeconds: 120,
  });

  // Act
  const { queue } = vision;

  // Assert
  assert.equal(queue, 'vision.r3');
});
