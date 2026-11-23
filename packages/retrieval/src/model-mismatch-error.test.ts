import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ModelMismatchError } from './index.ts';

test('ModelMismatchError holds both model identities and names them in its message', () => {
  // Arrange
  const stored = {
    provider: 'openai',
    modelId: 'text-embedding-3-small',
  };
  const query = {
    provider: 'openai',
    modelId: 'text-embedding-3-large',
  };

  // Act
  const error = new ModelMismatchError(stored, query);

  // Assert
  assert.ok(Error.isError(error));
  assert.equal(error.name, 'ModelMismatchError');
  assert.equal(
    error.message,
    'The query model openai/text-embedding-3-large is not the model of the stored vectors, openai/text-embedding-3-small',
  );
  assert.deepEqual(error.stored, stored);
  assert.deepEqual(error.query, query);
});
