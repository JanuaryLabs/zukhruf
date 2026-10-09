import { link, unlink, writeFile } from 'node:fs/promises';

import { draftOf } from './draft.ts';
import { isErrno } from './errno.ts';
import { patiently } from './patiently.ts';

/**
 * Creates `path` holding `content` unless it already exists. Linking a fully
 * written file makes creation atomic, so the file is never seen empty.
 */
export async function createExclusive(path: string, content: string) {
  const draft = draftOf(path);
  await writeFile(draft, content);
  try {
    await patiently(() => link(draft, path));
    return true;
  } catch (error) {
    if (isErrno(error, 'EEXIST')) return false;
    throw error;
  } finally {
    await removeDraft(draft);
  }
}

/** A draft left behind has a unique name, so it never blocks a key; failing to remove it must not change whether `path` was created. */
async function removeDraft(draft: string) {
  await patiently(() => unlink(draft)).catch(() => {});
}
