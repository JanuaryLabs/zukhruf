import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { test } from '@zukhruf/parameterized-test';

import { Camera, Contacts, SpeechRecognition } from './index.ts';

const run = promisify(execFile);
const index = fileURLToPath(new URL('./index.ts', import.meta.url));

describe('a request', () => {
  void test.each(
    [new Camera(), new Contacts(), new SpeechRecognition()],
    (service) =>
      test(`of ${service.constructor.name} with an aborted signal rejects with its reason and asks nothing`, async () => {
        // Arrange
        const controller = new AbortController();
        const reason = new Error('the caller stopped');
        controller.abort(reason);

        // Act and assert
        await assert.rejects(
          service.request({ signal: controller.signal }),
          (error) => error === reason,
        );
      }),
  );

  test('with an aborted signal starts no osascript', async () => {
    // Arrange: Node writes each spawn of child_process to stderr under
    // NODE_DEBUG=child_process; an execFile with an aborted signal still spawns.
    const program = `import { Camera } from ${JSON.stringify(index)};
await new Camera().request({ signal: AbortSignal.abort() }).catch(() => {});`;

    // Act
    const { stderr } = await run(
      process.execPath,
      ['--input-type=module', '--eval', program],
      { env: { ...process.env, NODE_DEBUG: 'child_process' } },
    );

    // Assert
    assert.doesNotMatch(stderr, /CHILD_PROCESS \d+: spawn/);
  });

  test('ends osascript and rejects with the reason when its signal aborts while it runs', async () => {
    // Arrange
    const controller = new AbortController();
    const reason = new Error('the caller stopped');

    // Act: request() spawns osascript before it returns, so this abort lands
    // while osascript runs.
    const pending = new Camera().request({ signal: controller.signal });
    controller.abort(reason);

    // Assert
    await assert.rejects(pending, (error) => error === reason);
  });
});
