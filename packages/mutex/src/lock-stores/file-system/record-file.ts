import { readFileSync } from 'node:fs';

import { isErrno, patiently } from '@zukhruf/fs';

/**
 * The text of the caller record at `path`, or `undefined` when there is none.
 *
 * Windows cannot replace a file while another handle has it open, so a
 * rename that replaces a record fails while waiters read it. A synchronous
 * read opens and closes the file in one call; the asynchronous read of
 * Node.js 24 keeps it open across several turns of the event loop.
 */
export async function readRecord(path: string): Promise<string | undefined> {
  try {
    return await patiently(async () => readFileSync(path, 'utf8'));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}
