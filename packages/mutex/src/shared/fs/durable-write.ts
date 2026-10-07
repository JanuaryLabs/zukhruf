import { randomUUID } from 'node:crypto';
import { open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { isErrno } from './errno.ts';
import { replaceFile } from './replace-file.ts';

const draftOf = (path: string) => `${path}.${randomUUID()}.tmp`;

/** The length of what `durableWrite` adds to a path to name its draft. */
export const draftSuffixLength = draftOf('').length;

/**
 * Replaces `path` in one step like `atomicWrite`, and returns only once both
 * the new content and the replacement survive a power loss: a counter that
 * goes back after a crash would hand out a token twice.
 */
export async function durableWrite(path: string, content: string) {
  const draft = draftOf(path);
  try {
    await writeSynced(draft, content);
    await replaceFile(draft, path);
  } catch (error) {
    // A draft that never replaced `path` would only pile up, one per failed write.
    await rm(draft, { force: true });
    throw error;
  }
  await syncDirectory(dirname(path));
}

async function writeSynced(path: string, content: string) {
  await using handle = await open(path, 'wx');
  await handle.writeFile(content);
  await handle.sync();
}

/**
 * A rename lives in its directory, so the directory must reach the disk too.
 * Windows cannot open a directory to sync it, and some file systems refuse to
 * sync one; there the rename is as durable as that system makes it.
 */
async function syncDirectory(directory: string) {
  if (process.platform === 'win32') return;
  await using handle = await open(directory, 'r');
  try {
    await handle.sync();
  } catch (error) {
    if (!isErrno(error, 'EINVAL') && !isErrno(error, 'ENOTSUP')) throw error;
  }
}
