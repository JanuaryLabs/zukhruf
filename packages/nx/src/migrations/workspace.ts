import { isDeepStrictEqual } from 'node:util';

import {
  type NxJsonConfiguration,
  type TargetConfiguration,
  type Tree,
  getProjects,
  joinPathFragments,
  readJson,
  visitNotIgnoredFiles,
  writeJson,
} from '@nx/devkit';

import { pluginName } from '../generators/init/nx-json.ts';

/** The package.json of a generated project: its targets are in its `nx` key. */
export interface ProjectManifest {
  name?: string;
  nx?: { targets?: Record<string, TargetConfiguration> };
}

/**
 * Changes a JSON file of the Tree only when `update` changes its value, so a
 * second run writes nothing, and a file whose keys are in another order keeps
 * its text. `update` changes the value it gets.
 */
export function updateJsonIfChanged<T extends object>(
  tree: Tree,
  path: string,
  update: (value: T) => void,
): void {
  const before = readJson<T>(tree, path);
  const after = structuredClone(before);
  update(after);
  if (!isDeepStrictEqual(before, after)) writeJson(tree, path, after);
}

/**
 * The root of each project that holds `marker`, the file a generator leaves
 * in the projects of its kind: `sdk-it.config.ts` for a node-app and
 * `prisma.config.ts` for a db package. Only a project root with a package.json
 * counts, because the generators write their targets there.
 */
export function projectRootsWith(tree: Tree, marker: string): string[] {
  return [...getProjects(tree).values()]
    .map((project) => project.root)
    .filter(
      (root) =>
        tree.exists(joinPathFragments(root, marker)) &&
        tree.exists(joinPathFragments(root, 'package.json')),
    )
    .toSorted();
}

/** Whether nx.json registers the plugin, for example `@nx/vite/plugin`. */
export function hasPlugin(tree: Tree, plugin: string): boolean {
  if (!tree.exists('nx.json')) return false;
  const { plugins = [] } = readJson<NxJsonConfiguration>(tree, 'nx.json');
  return plugins.some((entry) => pluginName(entry) === plugin);
}

const SOURCE = /\.[cm]?[jt]sx?$/;

/** Each source file under `directory` that Git does not ignore, `.ts`, `.tsx`, `.js`, `.mjs` and the like. */
export function sourceFiles(tree: Tree, directory = ''): string[] {
  const files: string[] = [];
  visitNotIgnoredFiles(tree, directory, (path) => {
    if (SOURCE.test(path)) files.push(path);
  });
  return files.toSorted();
}

/**
 * The value of `KEY` in an env file: undefined when the file has no line for
 * the key, and `''` for `KEY=`.
 */
export function envValue(content: string, key: string): string | undefined {
  return new RegExp(`^${key}=(.*)$`, 'm').exec(content)?.[1];
}
