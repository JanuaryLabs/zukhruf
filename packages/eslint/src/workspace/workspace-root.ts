import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { isRecord } from '../authoring/ast.ts';

// Rules run once per linted file; most files of a run share a few folders.
const rootByDirectory = new Map<string, string | undefined>();

function declaresWorkspaces(directory: string): boolean {
  const manifest = join(directory, 'package.json');
  if (!existsSync(manifest)) return false;
  const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
  return isRecord(parsed) && 'workspaces' in parsed;
}

function isWorkspaceRoot(directory: string): boolean {
  return (
    existsSync(join(directory, 'nx.json')) ||
    existsSync(join(directory, 'pnpm-workspace.yaml')) ||
    declaresWorkspaces(directory)
  );
}

/**
 * The workspace that holds `directory`: the nearest folder at or above it with
 * an nx.json, a pnpm-workspace.yaml, or a package.json that declares
 * workspaces. It is found from the path being linted, never from where this
 * module or the ESLint config sits: installed under node_modules, or loaded by
 * a project's own config under `nx lint`, those say nothing about the
 * workspace.
 */
export function workspaceRootOf(directory: string): string | undefined {
  const start = resolve(directory);
  if (!rootByDirectory.has(start)) {
    rootByDirectory.set(start, findWorkspaceRoot(start));
  }
  return rootByDirectory.get(start);
}

function findWorkspaceRoot(directory: string): string | undefined {
  if (isWorkspaceRoot(directory)) return directory;
  const parent = dirname(directory);
  return parent === directory ? undefined : workspaceRootOf(parent);
}

/** `filename` relative to its workspace root with `/` separators; the absolute path outside any workspace. */
export function relativeToWorkspace(filename: string): string {
  const absolute = resolve(filename);
  const root = workspaceRootOf(dirname(absolute));
  const path = root === undefined ? absolute : relative(root, absolute);
  return path.split(sep).join('/');
}
