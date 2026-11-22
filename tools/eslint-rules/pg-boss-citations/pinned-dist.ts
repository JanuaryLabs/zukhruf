import { readFileSync, readdirSync } from 'node:fs';
import { findPackageJSON } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The pg-boss that Node resolves from a file: its version and the line count of each file of its dist. */
export interface PinnedDist {
  readonly version: string;
  readonly lines: ReadonlyMap<string, number>;
}

// Rules run once per linted file; the files of a package share one pg-boss.
const byManifest = new Map<string, PinnedDist>();

export function pinnedDist(from: string): PinnedDist {
  const manifest = findPackageJSON('pg-boss', pathToFileURL(from));
  if (manifest === undefined) {
    throw new Error(`pg-boss resolves from ${from} to no package.json`);
  }
  const cached = byManifest.get(manifest);
  if (cached) return cached;
  const dist = join(dirname(manifest), 'dist');
  const files = readdirSync(dist, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.js'))
    .map((file) => file.replaceAll('\\', '/'));
  const read: PinnedDist = {
    version: String(JSON.parse(readFileSync(manifest, 'utf8')).version),
    lines: new Map(
      files.map((file) => [
        file,
        lineCount(readFileSync(join(dist, file), 'utf8')),
      ]),
    ),
  };
  byManifest.set(manifest, read);
  return read;
}

function lineCount(text: string): number {
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
}
