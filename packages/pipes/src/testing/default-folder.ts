import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';

export interface DefaultFolder extends AsyncDisposable {
  /** A prefix that no other test uses. */
  readonly prefix: string;
  /** `/tmp/<prefix>-<uid>`, the folder that the package makes for the plain names of `prefix`. */
  readonly path: string;
}

/** A fresh prefix, and the removal of its default folder at the end of the test. */
export function defaultFolder(): DefaultFolder {
  const prefix = `pipes-test-${randomUUID().slice(0, 8)}`;
  const path = `/tmp/${prefix}-${process.getuid!()}`;
  return {
    prefix,
    path,
    [Symbol.asyncDispose]: () => rm(path, { recursive: true, force: true }),
  };
}
