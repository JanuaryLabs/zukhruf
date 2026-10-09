import { writeFile } from 'node:fs/promises';

import { draftOf } from './draft.ts';
import { replaceFile } from './replace-file.ts';

/** Replaces `path` in one step, so readers see the old or the new content, never a partial write. */
export async function atomicWrite(path: string, content: string) {
  const draft = draftOf(path);
  await writeFile(draft, content);
  await replaceFile(draft, path);
}
