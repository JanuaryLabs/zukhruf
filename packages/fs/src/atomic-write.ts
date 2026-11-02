import { rm, writeFile } from 'node:fs/promises';

import type { Clock } from '@zukhruf/async';

import { draftOf } from './draft.ts';
import { replaceFile } from './replace-file.ts';

/**
 * Replaces `path` in one step, so readers see the old or the new content, never a partial write.
 * `mode` is set when the draft is created: the rename keeps the draft's mode,
 * so the file never has another mode at the path.
 */
export async function atomicWrite(
  path: string,
  content: string | Uint8Array,
  { clock, mode }: { clock: Clock; mode?: number },
) {
  const draft = draftOf(path);
  try {
    await writeFile(draft, content, { mode });
    await replaceFile(draft, path, clock);
  } catch (error) {
    // A draft that never replaced `path` would only pile up, one per failed write.
    await rm(draft, { force: true });
    throw error;
  }
}
