import { posix } from 'node:path';

import { type Tree, readJson } from '@nx/devkit';

export interface AppDirectory {
  /** The project root, relative to the workspace root, for example `apps/backend`. */
  projectRoot: string;
  /** The last segment of the project root, for example `backend`. */
  name: string;
  /** The path from the project root to the workspace root, for example `../../`. */
  rootOffset: string;
}

/** Reads the `directory` option of an app generator. */
export function appDirectory(directory: string): AppDirectory {
  const projectRoot = posix
    .normalize(directory.replaceAll('\\', '/'))
    .replace(/^\/+|\/+$/g, '');
  const name = projectRoot.split('/').at(-1);
  if (!name || name === '.' || projectRoot.startsWith('..')) {
    throw new Error(
      `The directory ${JSON.stringify(directory)} is not a folder in the workspace.`,
    );
  }
  return {
    projectRoot,
    name,
    rootOffset: '../'.repeat(projectRoot.split('/').length),
  };
}

/**
 * The Nx project name of a project whose targets are in its package.json:
 * `nx.name` when set, else the package name.
 */
export function projectNameOf(tree: Tree, projectRoot: string): string {
  const path = `${projectRoot}/package.json`;
  if (!tree.exists(path)) {
    throw new Error(`${path} does not exist.`);
  }
  const packageJson = readJson<{ name?: string; nx?: { name?: string } }>(
    tree,
    path,
  );
  const name = packageJson.nx?.name ?? packageJson.name;
  if (name === undefined) {
    throw new Error(`${path} has no name.`);
  }
  return name;
}
