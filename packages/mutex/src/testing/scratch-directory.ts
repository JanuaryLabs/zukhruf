import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A fresh temporary directory, removed when the test's `await using` scope ends. */
export async function scratchDirectory() {
  const path = await mkdtemp(join(tmpdir(), 'mutex-test-'));
  return {
    path,
    [Symbol.asyncDispose]: () => rm(path, { recursive: true, force: true }),
  };
}
