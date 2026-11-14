import { hash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { InvalidModelArtifactError } from './invalid-model-artifact-error.ts';
import { Manifest } from './manifest.ts';

// The model directory at `path`, after each file that its manifest.json
// lists matches its SHA-256, as Venn's runtime.model_directory checks the
// head (venn/runtime.py:11).
export async function modelDirectory(path: string): Promise<string> {
  const manifest = await Manifest.read(path);
  for (const [name, digest] of manifest.digests) {
    // Venn refuses a name whose parent is not the directory, and Python's
    // Path keeps "..", so the name is one segment. The check reads no link:
    // a file of the Hub cache is a link into its blobs folder.
    if (basename(name) !== name || name === '' || name === '.' || name === '..')
      throw new InvalidModelArtifactError(
        name,
        'is not a file of the model directory',
      );
    const actual = hash('sha256', await readFile(join(path, name)));
    if (actual !== digest)
      throw new InvalidModelArtifactError(
        name,
        'does not match its SHA-256 in manifest.json',
      );
  }
  return path;
}
