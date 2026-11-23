import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ModelMismatchError } from './index.ts';

test('ModelMismatchError holds both model identities and names them in its message', () => {
  // Arrange
  const stored = {
    provider: 'openai',
    modelId: 'text-embedding-3-small',
    dimensions: 1536,
  };
  const query = {
    provider: 'openai',
    modelId: 'text-embedding-3-large',
    dimensions: 3072,
  };

  // Act
  const error = new ModelMismatchError(stored, query);

  // Assert
  assert.ok(Error.isError(error));
  assert.equal(error.name, 'ModelMismatchError');
  assert.equal(
    error.message,
    'The query model openai/text-embedding-3-large (3072 dimensions) is not the model of the stored vectors, openai/text-embedding-3-small (1536 dimensions)',
  );
  assert.deepEqual(error.stored, stored);
  assert.deepEqual(error.query, query);
});
