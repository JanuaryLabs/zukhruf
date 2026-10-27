import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sha256 } from '../answer-key.ts';
import { CACHE_FOLDER } from './text-source.ts';

export const USER_AGENT =
  'zukhruf-event-grouping-eval/1 (+https://github.com/JanuaryLabs/zukhruf)';

// A file of a public corpus at one revision. The first use downloads it into
// the cache. Each use checks its sha256, so a corpus that changed stops the
// run.
export async function pinnedFile(
  name: string,
  url: string,
  expected: string,
): Promise<{ readonly path: string; readonly bytes: Buffer }> {
  const folder = join(CACHE_FOLDER, 'sources');
  const path = join(folder, name);
  if (!existsSync(path)) {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(300_000),
    });
    if (!response.ok)
      throw new Error(`${url} answered HTTP ${response.status}.`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path, Buffer.from(await response.arrayBuffer()));
  }
  const bytes = readFileSync(path);
  const actual = sha256(bytes);
  if (actual !== expected)
    throw new Error(
      `${url} changed: sha256 ${actual}, expected ${expected}. Delete ${path} to download it again; when the corpus itself changed, the set needs new labels.`,
    );
  return { path, bytes };
}
