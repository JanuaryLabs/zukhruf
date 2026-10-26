import { join, posix } from 'node:path';

import {
  type ProjectGraph,
  type ProjectGraphProjectNode,
  workspaceRoot,
} from '@nx/devkit';

import { isRecord, stringsAt } from '../unknown-values.ts';
import { readJson } from '../workspace/project-manifest.ts';

/** The file paths a manifest's `exports` maps to, in any of its forms. */
function exportTargets(exports: unknown): string[] {
  if (typeof exports === 'string') return [exports];
  if (Array.isArray(exports)) return exports.flatMap(exportTargets);
  return isRecord(exports) ? Object.values(exports).flatMap(exportTargets) : [];
}

/**
 * Whether the manifest publishes a `testing/` folder: an `exports` target or
 * a `files` entry names a `testing` segment, or an `exports` target has a
 * `*`, which can reach any folder.
 */
function publishesTesting(manifest: unknown): boolean {
  const exports = isRecord(manifest) ? exportTargets(manifest['exports']) : [];
  return (
    exports.some((path) => path.includes('*')) ||
    [...exports, ...stringsAt(manifest, 'files')].some((path) =>
      path.split('/').includes('testing'),
    )
  );
}

/** `project` and, when its build inlines them, the workspace projects it imports, transitively. */
function checkedProjects(
  graph: ProjectGraph,
  project: ProjectGraphProjectNode,
  bundled: boolean,
): ProjectGraphProjectNode[] {
  const seen = new Map([[project.name, project]]);
  if (!bundled) return [...seen.values()];
  const visit = (name: string) => {
    for (const { target } of graph.dependencies[name] ?? []) {
      const node = graph.nodes[target];
      if (!node || seen.has(target)) continue;
      seen.set(target, node);
      visit(target);
    }
  };
  visit(project.name);
  return [...seen.values()];
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
  return checkedProjects(graph, project, bundled)
    .filter(
      ({ data }) =>
        !publishesTesting(
          readJson(join(workspaceRoot, data.root, 'package.json')),
        ),
    )
    .map(({ data }) => posix.join(data.root, '**/testing/**'));
}
