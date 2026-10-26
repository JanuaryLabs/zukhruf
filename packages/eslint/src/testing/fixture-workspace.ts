import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { TemporaryFiles } from '@zukhruf/testing/fs';

export interface FixtureWorkspace extends AsyncDisposable {
  readonly root: string;
  /** Absolute path of a file inside the workspace. */
  path(relativePath: string): string;
}

/**
 * A temporary folder holding `files` (workspace-relative path → content).
 * Include an `nx.json` to make it a workspace root. Disposing deletes it, so a
 * test declares it with `await using` and needs no teardown hook. The root is
 * the real path, as a child process reports its cwd.
 */
export async function fixtureWorkspace(
  files: Record<string, string>,
): Promise<FixtureWorkspace> {
  const folder = await new TemporaryFiles().directory('zukhruf-eslint-');
  const root = folder.path;
  for (const [relativePath, content] of Object.entries(files)) {
    const file = join(root, relativePath);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return {
    root,
    path: (relativePath) => join(root, relativePath),
    [Symbol.asyncDispose]: folder.cleanup,
  };
}
