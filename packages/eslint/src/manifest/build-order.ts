import type { ProjectGraph, ProjectGraphProjectNode } from '@nx/devkit';

import {
  isImport,
  reachableProjects,
} from '../workspace/cached-project-graph.ts';

/** The npm packages that the code of the projects `names` imports. */
function importedPackages(
  graph: ProjectGraph,
  names: Iterable<string>,
): Set<string> {
  const packages = new Set<string>();
  for (const name of names) {
    for (const dependency of graph.dependencies[name] ?? []) {
      const npm = graph.externalNodes?.[dependency.target];
      if (npm && isImport(dependency)) packages.add(npm.data.packageName);
    }
  }
  return packages;
}

/**
 * The npm packages that only the projects a bundled `project` builds after
 * import. Nx's dependency-checks follows every edge of the graph, an
 * `implicitDependencies` edge too, but such an edge only orders the builds:
 * the bundle holds none of the code it reaches.
 */
export function buildOrderOnlyPackages(
  graph: ProjectGraph,
  project: ProjectGraphProjectNode,
): string[] {
  const bundled = reachableProjects(graph, project, isImport);
  const walked = reachableProjects(graph, project, () => true);
  const buildOrderOnly = new Set(walked.keys()).difference(bundled);
  return [
    ...importedPackages(graph, buildOrderOnly).difference(
      importedPackages(graph, bundled.keys()),
    ),
  ];
}
