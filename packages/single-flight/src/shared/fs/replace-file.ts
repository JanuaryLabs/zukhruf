import { rename } from 'node:fs/promises';

import { patiently } from './patiently.ts';

/**
 * Moves `draft` over `path` in one step. On Windows, a rename over a file
 * fails while another process has that file open, for example a waiter that
 * reads it at that moment. The refusal is brief, so the rename is tried again;
 * it stays the single commit point.
 */
export function replaceFile(draft: string, path: string) {
  return patiently(() => rename(draft, path));
}
