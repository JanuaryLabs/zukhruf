import { rm, writeFile } from 'node:fs/promises';

import { draftOf } from './draft.ts';
import { replaceFile } from './replace-file.ts';

/** Replaces `path` in one step, so readers see the old or the new content, never a partial write. */
export async function atomicWrite(path: string, content: string) {
  const draft = draftOf(path);
  try {
    await writeFile(draft, content);
    await replaceFile(draft, path);
  } catch (error) {
    // A draft that never replaced `path` would only pile up, one per failed write.
    await rm(draft, { force: true });
    throw error;
  }
}
