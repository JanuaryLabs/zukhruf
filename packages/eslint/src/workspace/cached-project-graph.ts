import { join, resolve } from 'node:path';

import {
  DependencyType,
  type ProjectGraph,
  type ProjectGraphDependency,
  type ProjectGraphProjectNode,
  readCachedProjectGraph,
  workspaceRoot,
} from '@nx/devkit';

import { isRecord } from '../unknown-values.ts';
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

/**
 * Whether the edge comes from the source project's code, as a static or a
 * dynamic import. An implicit dependency (`implicitDependencies`) only orders
 * the builds: the source's code never loads the target.
 */
export function isImport({ type }: ProjectGraphDependency): boolean {
  return type !== DependencyType.implicit;
}

/**
 * `from` and every workspace project it reaches through the edges that
 * `follow` keeps, transitively, by name.
 */
export function reachableProjects(
  graph: ProjectGraph,
  from: ProjectGraphProjectNode,
  follow: (dependency: ProjectGraphDependency) => boolean,
): Map<string, ProjectGraphProjectNode> {
  const seen = new Map([[from.name, from]]);
  const visit = (name: string) => {
    for (const dependency of graph.dependencies[name] ?? []) {
      const node = graph.nodes[dependency.target];
      if (!node || seen.has(node.name) || !follow(dependency)) continue;
      seen.set(node.name, node);
      visit(node.name);
    }
  };
  visit(from.name);
  return seen;
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
