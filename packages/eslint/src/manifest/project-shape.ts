import { join } from 'node:path';

import { isRecord } from '../authoring/ast.ts';
import { readJson } from '../workspace/project-manifest.ts';

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

/** project.json, or the `nx` field of package.json for a project without one. */
function nxConfiguration(projectRoot: string): Record<string, unknown> {
  const projectJson = readJson(join(projectRoot, 'project.json'));
  if (isRecord(projectJson)) return projectJson;
  const packageJson = readJson(join(projectRoot, 'package.json'));
  const nx = isRecord(packageJson) ? packageJson['nx'] : undefined;
  return isRecord(nx) ? nx : {};
}

/**
 * The shape of the project at `projectRoot`, from its build target. An
 * application bundles unless its build is `nx:noop` (it ships what other
 * projects built) or esbuild with `bundle: false` (it transpiles file by file).
 * esbuild bundles by default. A build target that an Nx plugin infers, such as
 * Vite's, is not in project.json, and counts as bundling.
 */
export function projectShape(projectRoot: string): ProjectShape {
  const project = nxConfiguration(projectRoot);
  if (project['projectType'] !== 'application') return 'unbundled';
  const targets = project['targets'];
  const build = isRecord(targets) ? targets['build'] : undefined;
  const executor = isRecord(build) ? build['executor'] : undefined;
  if (executor === 'nx:noop') return 'unbundled';
  if (typeof executor === 'string' && executor.includes('esbuild')) {
    const options = isRecord(build) ? build['options'] : undefined;
    return isRecord(options) && options['bundle'] === false
      ? 'unbundled'
      : 'bundled';
  }
  return 'bundled';
}
