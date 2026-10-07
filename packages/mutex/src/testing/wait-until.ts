import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';

/**
 * How long a test waits for a new Node process or worker thread to start and
 * report. It loads the TypeScript sources first: about 170 ms on a calm
 * machine, and more than 2 s on a busy CI runner.
 */
export const newProcessTimeout = 10_000;

export function waitUntil(
  t: TestContext,
  condition: () => boolean,
  message: string,
  timeout = 2000,
) {
  return t.waitFor(() => assert.ok(condition(), message), {
    interval: 5,
    timeout,
  });
}
