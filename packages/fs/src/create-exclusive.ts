import { link, unlink, writeFile } from 'node:fs/promises';

import type { Clock } from '@zukhruf/async';

import { draftOf } from './draft.ts';
import { isErrno } from './errno.ts';
import { patiently } from './patiently.ts';

/**
 * Creates `path` holding `content` unless it already exists. Linking a fully
 * written file makes creation atomic, so the file is never seen empty. When
 * the create fails and the removal of its draft fails too, it rejects with a
 * `SuppressedError`: its `suppressed` is the failure of the create, and its
 * `error` is the failure of the removal.
 */
export async function createExclusive(
  path: string,
  content: string,
  { clock }: { clock: Clock },
) {
  const draft = draftOf(path);
  const created = await createFromDraft(draft, path, content, clock);
  // A draft left behind has a unique name, so it never blocks a key; failing to remove it must not change whether `path` was created, so nobody is left to tell of it.
  await removeDraft(draft, clock).catch((error: unknown) => {
    process.emitWarning(
      Error.isError(error) ? error : new Error(String(error), { cause: error }),
    );
  });
  return created;
}

async function createFromDraft(
  draft: string,
  path: string,
  content: string,
  clock: Clock,
) {
  try {
    await writeFile(draft, content);
    await patiently(() => link(draft, path), { clock });
    return true;
  } catch (error) {
    if (isErrno(error, 'EEXIST')) return false;
    await using removing = new AsyncDisposableStack();
    removing.defer(() => removeDraft(draft, clock));
    throw error;
  }
}

async function removeDraft(draft: string, clock: Clock) {
  try {
    await patiently(() => unlink(draft), { clock });
  } catch (error) {
    // A write that failed before it opened the draft left none to remove.
    if (!isErrno(error, 'ENOENT')) throw error;
  }
}
