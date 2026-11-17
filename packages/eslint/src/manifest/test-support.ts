import { join, posix } from 'node:path';

import {
  type ProjectGraph,
  type ProjectGraphProjectNode,
  workspaceRoot,
} from '@nx/devkit';

import { isRecord, stringsAt } from '../unknown-values.ts';
import { reachableProjects } from '../workspace/cached-project-graph.ts';
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
  return checkedProjects(graph, project, bundled)
    .filter(
      ({ data }) =>
        !publishesTesting(
          readJson(join(workspaceRoot, data.root, 'package.json')),
        ),
    )
    .map(({ data }) => posix.join(data.root, '**/testing/**'));
}
