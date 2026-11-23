import assert from 'node:assert/strict';
import { test } from 'node:test';

import { VectorMissingError } from './index.ts';

test('VectorMissingError holds the id of the passage and tells the caller to ask for vectors', () => {
  // Act
  const error = new VectorMissingError('docs:7');

  // Assert
  assert.ok(Error.isError(error));
  assert.equal(error.name, 'VectorMissingError');
  assert.equal(
    error.message,
    'The passage docs:7 has no vector: retrieve with includeVectors: true',
  );
  assert.equal(error.passageId, 'docs:7');
});
