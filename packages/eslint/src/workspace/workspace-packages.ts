import { globSync } from 'node:fs';
import { basename, join } from 'node:path';

import { isRecord } from '../authoring/ast.ts';
import { readJson } from './project-manifest.ts';

// Build output, installed packages, and dot-folders (worktrees of other
// checkouts among them) hold manifests that are not this workspace's packages.
const skipped = (path: string) => {
  const name = basename(path);
  return name === 'node_modules' || name === 'dist' || name.startsWith('.');
};

// One scan per workspace for the life of the process.
const packagesByRoot = new Map<string, readonly string[]>();

function scan(workspaceRoot: string): readonly string[] {
  return globSync('**/package.json', { cwd: workspaceRoot, exclude: skipped })
    .filter((path) => path !== 'package.json')
    .flatMap((path) => {
      const manifest = readJson(join(workspaceRoot, path));
      const name = isRecord(manifest) ? manifest['name'] : undefined;
      return typeof name === 'string' ? [name] : [];
    });
}

/**
 * The name of every package in the workspace, the root manifest aside. The
 * folders are scanned, not the root `workspaces` globs: a single-level `*`
 * there misses nested packages.
 */
export function workspacePackages(workspaceRoot: string): readonly string[] {
  const known = packagesByRoot.get(workspaceRoot);
  if (known) return known;
  const names = scan(workspaceRoot);
  packagesByRoot.set(workspaceRoot, names);
  return names;
}
