import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Clock } from '@zukhruf/async';
import {
  draftSuffixLength,
  durableWrite,
  isErrno,
  safeFileName,
} from '@zukhruf/fs';

import { FencingToken } from './fencing-token.ts';
import type { TokenSource } from './token-source.ts';

/**
 * Keeps one counter file per key in `directory`, so tokens keep growing across
 * process restarts and can fence durable resources. Relies on the caller holding
 * the key's lock: read, increment and replace are not atomic on their own.
 */
export class FileTokenSource implements TokenSource {
  readonly #directory: string;
  readonly #clock: Clock;

  /** `clock` runs the waits of the write of a counter: `globalThis` in production. */
  constructor(directory: string, { clock }: { clock: Clock }) {
    this.#directory = directory;
    this.#clock = clock;
  }

  async next(key: string): Promise<FencingToken> {
    await mkdir(this.#directory, { recursive: true });
    const name = safeFileName(key, '.fence'.length + draftSuffixLength);
    const path = join(this.#directory, `${name}.fence`);
    const token = (await readCounter(path)) + 1n;
    await durableWrite(path, token.toString(), { clock: this.#clock });
    return new FencingToken(token);
  }
}

async function readCounter(path: string): Promise<bigint> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return 0n;
    throw error;
  }
  const counter = FencingToken.parse(text);
  if (counter === null)
    throw new SyntaxError(
      `The fencing counter ${path} holds ${JSON.stringify(text)}, not decimal digits.`,
    );
  return counter.value;
}
