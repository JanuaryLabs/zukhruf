import { globSync } from 'node:fs';
import { join, posix, relative, resolve, sep } from 'node:path';

import {
  type ProjectGraph,
  type ProjectGraphProjectNode,
  workspaceRoot,
} from '@nx/devkit';

import { isRecord, stringsAt } from '../unknown-values.ts';
import { reachableProjects } from '../workspace/cached-project-graph.ts';
import { readJson } from '../workspace/project-manifest.ts';
import { exportTargets } from './package-exports.ts';

/** Whether `folder` is the folder `entry` names or lies inside it. */
function isInside(folder: string, entry: string): boolean {
  const path = posix.relative(entry, folder);
  return path !== '..' && !path.startsWith('../');
}

/**
 * Whether the manifest publishes the `testing/` folder at `folder`, relative
 * to the project root: an `exports` target or a `files` entry names a
 * `testing` segment, an `exports` target has a `*`, which can reach any
 * folder, or a `files` entry names the folder or a folder that holds it.
 */
function publishes(manifest: unknown, folder: string): boolean {
  const exports = isRecord(manifest) ? exportTargets(manifest['exports']) : [];
  const files = stringsAt(manifest, 'files');
  return (
    exports.some((path) => path.includes('*')) ||
    [...exports, ...files].some((path) =>
      path.split('/').includes('testing'),
    ) ||
    files.some((entry) => isInside(folder, entry))
  );
}

/**
 * The `testing/` folders of `project`, relative to its root. A folder inside
 * another project's root belongs to that project, as its files do in Nx.
 */
function testingFolders(
  graph: ProjectGraph,
  project: ProjectGraphProjectNode,
): string[] {
  const root = join(workspaceRoot, project.data.root);
  const otherRoots = new Set(
    Object.values(graph.nodes)
      .filter(({ name }) => name !== project.name)
      .map(({ data }) => join(workspaceRoot, data.root)),
  );
  return globSync('**/testing', {
    cwd: root,
    withFileTypes: true,
    exclude: (entry) =>
      entry.name === 'node_modules' ||
      otherRoots.has(resolve(root, entry.parentPath, entry.name)),
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) =>
      relative(root, join(entry.parentPath, entry.name))
        .split(sep)
        .join(posix.sep),
    );
}

/**
 * The projects whose files Nx's dependency-checks reads for `project`: the
 * project itself and, when it is bundled, every project the graph's edges
 * reach from it, as Nx follows them.
 */
function checkedProjects(
  graph: ProjectGraph,
  project: ProjectGraphProjectNode,
  bundled: boolean,
): ProjectGraphProjectNode[] {
  if (!bundled) return [project];
  return [...reachableProjects(graph, project, () => true).values()];
}

/**
 * The `testing/` folders that hold test support, as `ignoredFiles` globs. A
 * `testing/` folder is test support unless its project's manifest publishes it,
 * because a package can ship a testing subpath for its consumers. The globs
 * are relative to the workspace root, not `{projectRoot}`, because Nx applies
 * one `ignoredFiles` list to every project a bundled app inlines.
 */
export function testSupportFiles(
  graph: ProjectGraph,
  project: ProjectGraphProjectNode,
  bundled: boolean,
): string[] {
  return checkedProjects(graph, project, bundled).flatMap((node) => {
    const manifest = readJson(
      join(workspaceRoot, node.data.root, 'package.json'),
    );
    return testingFolders(graph, node)
      .filter((folder) => !publishes(manifest, folder))
      .map((folder) => posix.join(node.data.root, folder, '**'));
  });
}
