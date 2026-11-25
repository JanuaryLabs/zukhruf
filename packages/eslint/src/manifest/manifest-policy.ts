import type {
  ProjectFileMap,
  ProjectGraph,
  ProjectGraphProjectNode,
} from '@nx/devkit';

import {
  type DependencyPolicyOptions,
  dependencyPolicy,
} from '../nx-policy/dependency-policy.ts';
import { fileMapReader } from '../workspace/nx-file-map.ts';
import { buildOrderOnlyPackages } from './build-order.ts';
import { BundleReach } from './bundle-reach.ts';
import { ProjectBuild } from './project-build.ts';
import { testSupportFiles } from './test-support.ts';

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
 * demands. A bundled project declares the npm packages of the modules its
 * bundle loads, followed import by import from its shipped files through each
 * workspace package's `exports`, when `fileMap` (Nx's cached file map) is
 * given; without it, of every file of each workspace package it inlines. No
 * project declares the workspace packages its build inlines, what a project
 * it only builds after imports, or what a `testing/` folder that its manifest
 * does not publish imports.
 */
export function manifestPolicy(
  graph: ProjectGraph,
  project: ProjectGraphProjectNode,
  {
    projects = {},
    ignoredDependencies = [],
    ignoredFiles = [],
    ...options
  }: ManifestPolicyOptions = {},
  fileMap: ProjectFileMap = {},
) {
  const build = new ProjectBuild(graph, project);
  const bundled = build.shape === 'bundled';
  const policy = dependencyPolicy({
    ...options,
    includeTransitiveDependencies: bundled,
    ignoredFiles: [
      ...testSupportFiles(graph, project, bundled),
      ...ignoredFiles,
    ],
    ignoredDependencies: [
      ...build.inlined,
      ...(bundled ? buildOrderOnlyPackages(graph, project) : []),
      ...ignoredDependencies,
      ...(projects[project.data.root]?.ignoredDependencies ?? []),
    ],
  });
  if (!bundled || Object.keys(fileMap).length === 0) return policy;
  // Nx before 23.2 lacks the file map functions (april runs this rule on Nx 22.7.8): every file of an inlined package counts, as before.
  const nx = fileMapReader();
  if (!nx) return policy;
  const { unloaded } = new BundleReach(graph, fileMap, project, policy, nx);
  return { ...policy, ignoredFiles: [...policy.ignoredFiles, ...unloaded] };
}
