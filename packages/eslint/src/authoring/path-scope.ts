import { matchesGlob } from 'node:path';

import { TEST_EXTENSIONS } from '../files.ts';
import { relativeToWorkspace } from '../workspace/workspace-root.ts';

const TEST_FILE = new RegExp(
  String.raw`\.(test|spec)\.(${TEST_EXTENSIONS.join('|')})$`,
);

export function isTestFile(filename: string): boolean {
  return TEST_FILE.test(filename);
}

/**
 * Whether `filename` lies under one of `roots`, workspace-relative folders such
 * as `apps/backend/src`. An empty list means everywhere. Scoping lives in the
 * rule rather than in a config's `files` glob because `nx lint` runs ESLint from
 * the project folder: a project config that re-exports the root config resolves
 * the root's globs from the project, and a glob like `apps/**` matches nothing.
 */
export function inRoots(filename: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true;
  const path = relativeToWorkspace(filename);
  return roots.some((root) => {
    const folder = root.replace(/\/+$/, '');
    return path === folder || path.startsWith(`${folder}/`);
  });
}

/** Whether `filename`, relative to its workspace, matches one of `globs`. */
export function matchesAnyGlob(
  filename: string,
  globs: readonly string[],
): boolean {
  const path = relativeToWorkspace(filename);
  return globs.some((glob) => matchesGlob(path, glob));
}
