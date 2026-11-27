import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Command, StartError } from './index.ts';

test('a run of a file that does not exist rejects with StartError, whose cause is ENOENT', async () => {
  // Arrange
  const command = new Command('/nonexistent/zukhruf-process-tool', [], {
    env: {},
    clock: globalThis,
  });

  // Act
  const run = command.run();

  // Assert
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof StartError);
    assert.equal(Reflect.get(Object(error.cause), 'code'), 'ENOENT');
    return true;
  });
});
