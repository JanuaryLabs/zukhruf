import type { ProjectGraph, ProjectGraphProjectNode } from '@nx/devkit';

import {
  type DependencyPolicyOptions,
  dependencyPolicy,
} from '../nx-policy/dependency-policy.ts';
import { ProjectBuild } from './project-build.ts';

export interface ProjectExtras {
  /** Packages this project's manifest may leave out, on top of the repo's. */
  ignoredDependencies?: string[];
}

/** The project's shape decides `includeTransitiveDependencies`, so a repo does not set it. */
export interface ManifestPolicyOptions extends Omit<
  DependencyPolicyOptions,
  'includeTransitiveDependencies'
> {
  /** Extras for one project, keyed by its folder relative to the workspace root. */
  projects?: Record<string, ProjectExtras>;
}

/**
 * The complete `@nx/dependency-checks` options for `project`: the shared
 * policy, the repo's entries, the project's own extras, and what its shape
 * demands. A bundled project declares the npm packages its workspace imports
 * pull in. No project declares the workspace packages its build inlines.
 */
export function manifestPolicy(
  graph: ProjectGraph,
  project: ProjectGraphProjectNode,
  {
    projects = {},
    ignoredDependencies = [],
    ...options
  }: ManifestPolicyOptions = {},
) {
  const build = new ProjectBuild(graph, project);
  return dependencyPolicy({
    ...options,
    includeTransitiveDependencies: build.shape === 'bundled',
    ignoredDependencies: [
      ...build.inlined,
      ...ignoredDependencies,
      ...(projects[project.data.root]?.ignoredDependencies ?? []),
    ],
  });
}
