import { relative, sep } from 'node:path';

import {
  type DependencyPolicyOptions,
  dependencyPolicy,
} from '../nx-policy/dependency-policy.ts';
import { workspacePackages } from '../workspace/workspace-packages.ts';
import { workspaceRootOf } from '../workspace/workspace-root.ts';
import { projectShape } from './project-shape.ts';

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
 * The complete `@nx/dependency-checks` options for the project at
 * `projectRoot`: the shared policy, the repo's entries, the project's own
 * extras, and what its shape demands. A bundled project declares the npm
 * packages its workspace imports pull in, but not the workspace packages
 * themselves, which its build inlines.
 */
export function manifestPolicy(
  projectRoot: string,
  {
    projects = {},
    ignoredDependencies = [],
    ...options
  }: ManifestPolicyOptions = {},
) {
  const workspaceRoot = workspaceRootOf(projectRoot) ?? projectRoot;
  const folder = relative(workspaceRoot, projectRoot).split(sep).join('/');
  const bundled = projectShape(projectRoot) === 'bundled';
  return dependencyPolicy({
    ...options,
    includeTransitiveDependencies: bundled,
    ignoredDependencies: [
      ...(bundled ? workspacePackages(workspaceRoot) : []),
      ...ignoredDependencies,
      ...(projects[folder]?.ignoredDependencies ?? []),
    ],
  });
}
