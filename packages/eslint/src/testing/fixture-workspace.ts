import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface FixtureWorkspace extends Disposable {
  readonly root: string;
  /** Absolute path of a file inside the workspace. */
  path(relativePath: string): string;
}

/**
 * A temporary folder holding `files` (workspace-relative path → content).
 * Include an `nx.json` to make it a workspace root. Disposing deletes it, so a
 * test declares it with `using` and needs no teardown hook.
 */
export function fixtureWorkspace(
  files: Record<string, string>,
): FixtureWorkspace {
  // The real path: macOS's tmpdir is a symlink and Windows' can use 8.3 short
  // names, while a child process reports its cwd fully resolved.
  const root = realpathSync.native(
    mkdtempSync(join(tmpdir(), 'zukhruf-eslint-')),
  );
  for (const [relativePath, content] of Object.entries(files)) {
    const file = join(root, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return {
    root,
    path: (relativePath) => join(root, relativePath),
    [Symbol.dispose]: () => rmSync(root, { recursive: true, force: true }),
  };
}
