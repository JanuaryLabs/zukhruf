import { join, resolve } from 'node:path';

import {
  type ProjectGraph,
  type ProjectGraphProjectNode,
  readCachedProjectGraph,
  workspaceRoot,
} from '@nx/devkit';

import { isRecord } from '../authoring/ast.ts';
import { readJson } from './project-manifest.ts';

/**
 * The project graph that `nx` caches, read as Nx's own lint rules read it.
 * There is none before Nx builds one, as on a fresh clone; Nx's rules then
 * skip their checks.
 */
export function cachedProjectGraph(): ProjectGraph | undefined {
  try {
    return readCachedProjectGraph();
  } catch {
    return undefined;
  }
}

/**
 * The npm name of a workspace project, from the package.json in its folder:
 * the name Nx's dependency-checks demands for it. The graph's own metadata
 * leaves it out for some projects.
 */
export function workspacePackageName(
  node: ProjectGraphProjectNode,
): string | undefined {
  const manifest = readJson(
    join(workspaceRoot, node.data.root, 'package.json'),
  );
  const name = isRecord(manifest) ? manifest['name'] : undefined;
  return typeof name === 'string' ? name : undefined;
}

/** The graph's project whose folder is `projectRoot`, an absolute path. */
export function projectNodeAt(
  graph: ProjectGraph,
  projectRoot: string,
): ProjectGraphProjectNode | undefined {
  return Object.values(graph.nodes).find(
    (node) => resolve(workspaceRoot, node.data.root) === projectRoot,
  );
}
