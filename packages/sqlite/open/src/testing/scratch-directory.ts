import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A fresh temporary directory at its real path, removed when the test's `await using` scope ends. */
export async function scratchDirectory() {
  const created = await mkdtemp(join(tmpdir(), 'sqlite-open-test-'));
  const path = await realpath(created);
  return {
    path,
    [Symbol.asyncDispose]: () =>
      rm(created, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      }),
  };
}
