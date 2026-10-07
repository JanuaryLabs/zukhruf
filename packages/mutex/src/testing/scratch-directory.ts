import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A fresh temporary directory, removed when the test's `await using` scope ends.
 * Removal retries: a caller that cancelled or gave up gets its answer at once,
 * but its lock store finishes the attempt in the background and may still hold
 * a file open, and Windows refuses to remove an open file.
 */
export async function scratchDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'mutex-test-'));
  return {
    path,
    [Symbol.asyncDispose]: () =>
      rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
  };
}
