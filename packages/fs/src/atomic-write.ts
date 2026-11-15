import { chmod, rm, writeFile } from 'node:fs/promises';

import type { Clock } from '@zukhruf/async';

import { draftOf } from './draft.ts';
import { replaceFile } from './replace-file.ts';

/**
 * Replaces `path` in one step, so readers see the old or the new content, never a partial write.
 * The draft gets `mode` before the rename, and the rename keeps the draft's
 * mode, so the file never has another mode at the path.
 */
export async function atomicWrite(
  path: string,
  content: string | Uint8Array,
  { clock, mode }: { clock: Clock; mode?: number },
) {
  const draft = draftOf(path);
  try {
    await writeFile(draft, content, { mode });
    // The umask masks the mode of a new file; a chmod does not, as in write-file-atomic 5.0.1 (lib/index.js:134).
    if (mode !== undefined) await chmod(draft, mode);
    await replaceFile(draft, path, clock);
  } catch (error) {
    // A draft that never replaced `path` would only pile up, one per failed write.
    await rm(draft, { force: true });
    throw error;
  }
}
