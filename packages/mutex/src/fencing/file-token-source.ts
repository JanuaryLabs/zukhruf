import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { draftSuffixLength, durableWrite } from '../shared/fs/durable-write.ts';
import { isErrno } from '../shared/fs/errno.ts';
import { safeFileName } from '../shared/fs/safe-file-name.ts';
import { FencingToken } from './fencing-token.ts';
import type { TokenSource } from './token-source.ts';

/**
 * Keeps one counter file per key in `directory`, so tokens keep growing across
 * process restarts and can fence durable resources. Relies on the caller holding
 * the key's lock: read, increment and replace are not atomic on their own.
 */
export class FileTokenSource implements TokenSource {
  readonly #directory: string;

  constructor(directory: string) {
    this.#directory = directory;
  }

  async next(key: string): Promise<FencingToken> {
    await mkdir(this.#directory, { recursive: true });
    const name = safeFileName(key, '.fence'.length + draftSuffixLength);
    const path = join(this.#directory, `${name}.fence`);
    const token = (await readCounter(path)) + 1n;
    await durableWrite(path, token.toString());
    return new FencingToken(token);
  }
}

async function readCounter(path: string): Promise<bigint> {
  try {
    return BigInt(await readFile(path, 'utf8'));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 0n;
    throw error;
  }
}
