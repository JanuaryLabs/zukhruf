import type { ProjectGraph, ProjectGraphProjectNode } from '@nx/devkit';

import { isRecord, stringsAt } from '../unknown-values.ts';
import { workspacePackageName } from '../workspace/cached-project-graph.ts';

/**
 * What a project's package.json must declare.
 *
 * - `bundled`: an application whose build inlines the workspace packages it
 *   imports. Their manifests are not there when it is deployed, so its own
 *   manifest declares every npm package they pull in, transitively.
 * - `unbundled`: everything else. It declares only what its own code imports;
 *   whoever installs it resolves the rest.
 */
export type ProjectShape = 'bundled' | 'unbundled';

/**
 * The patterns esbuild leaves to node_modules, as Nx hands them over:
 * `esbuildOptions.external` and `external`, less `excludeFromExternal`.
 */
function esbuildExternals(options: unknown): string[] {
  if (!isRecord(options)) return [];
  const excluded = new Set(stringsAt(options, 'excludeFromExternal'));
  return [
    ...stringsAt(options['esbuildOptions'], 'external'),
    ...stringsAt(options, 'external'),
  ].filter((pattern) => !excluded.has(pattern));
}

/** esbuild's rule: a pattern has at most one `*`, which stands for any text. */
function matchesExternal(name: string, pattern: string): boolean {
  const star = pattern.indexOf('*');
  if (star === -1) return name === pattern;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  return (
    name.length >= prefix.length + suffix.length &&
    name.startsWith(prefix) &&
    name.endsWith(suffix)
  );
}

/**
 * How one project's build ships the workspace packages, read from the project
 * as Nx resolves it: project.json, the target defaults in nx.json, and the
 * targets that Nx plugins infer.
 *
 * An application bundles unless its build is `nx:noop` (it ships what other
 * projects built), esbuild with `bundle: false` (it transpiles file by file),
 * or esbuild that leaves a workspace package it imports to node_modules (it
 * installs that package, and inlines only the others). esbuild bundles by
 * default.
 */
export class ProjectBuild {
  readonly shape: ProjectShape;
  /** The workspace packages the build copies into its output. The project's manifest never declares them. */
  readonly inlined: readonly string[];

  constructor(graph: ProjectGraph, project: ProjectGraphProjectNode) {
    const build = project.data.targets?.['build'];
    const esbuild = build?.executor?.includes('esbuild') === true;
    if (
      project.data.projectType !== 'application' ||
      build?.executor === 'nx:noop' ||
      (esbuild && build?.options?.bundle === false)
    ) {
      this.shape = 'unbundled';
      this.inlined = [];
      return;
    }
    const externals = esbuild ? esbuildExternals(build?.options) : [];
    const external = (name: string) =>
      externals.some((pattern) => matchesExternal(name, pattern));
    const installs = graph.dependencies[project.name]?.some(({ target }) => {
      const dependency = graph.nodes[target];
      const name = dependency && workspacePackageName(dependency);
      return name !== undefined && external(name);
    });
    this.shape = installs ? 'unbundled' : 'bundled';
    this.inlined = Object.values(graph.nodes)
      .flatMap((node) => workspacePackageName(node) ?? [])
      .filter((name) => !external(name));
  }
}
