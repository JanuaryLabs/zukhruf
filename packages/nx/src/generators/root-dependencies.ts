import { type Tree, readJson, updateJson } from '@nx/devkit';

import {
  type RootPackageJson,
  pinNxFamily,
  sortKeys,
} from './init/root-package-json.ts';

/** The names in the root `dependencies` and `devDependencies`, before an Nx generator runs. */
export function rootDependencyNames(tree: Tree): Set<string> {
  const { dependencies, devDependencies } = readJson<RootPackageJson>(
    tree,
    'package.json',
  );
  return new Set([
    ...Object.keys(dependencies ?? {}),
    ...Object.keys(devDependencies ?? {}),
  ]);
}

export interface RootDependencies {
  /** The packages of the app. A package that was there before keeps its version. */
  devDependencies: Record<string, string>;
  /** Packages that the Nx generator adds and no project loads. They go when the run added them. */
  residue?: readonly string[];
  /** The install scripts of the packages that the generator adds. A decision that is there stays. */
  allowScripts?: Record<string, boolean>;
  /** Edges of `overrides`. An edge that is there stays. */
  overrides?: Record<string, unknown>;
}

/**
 * Settles the root package.json after an Nx generator ran: each package of
 * `devDependencies` that was not there before gets its version, also over the
 * version that the Nx generator wrote; each name of `residue` that the run
 * added goes; and `nx` and each `@nx/*` get `nxVersion` (#4532).
 */
export function settleRootDependencies(
  tree: Tree,
  before: Set<string>,
  settings: RootDependencies,
): void {
  updateJson(tree, 'package.json', (packageJson: RootPackageJson) => {
    const dependencies = { ...packageJson.dependencies };
    const devDependencies = { ...packageJson.devDependencies };
    for (const [name, version] of Object.entries(settings.devDependencies)) {
      if (before.has(name)) continue;
      if (name in dependencies) {
        dependencies[name] = version;
      } else {
        devDependencies[name] = version;
      }
    }
    for (const name of settings.residue ?? []) {
      if (before.has(name)) continue;
      delete dependencies[name];
      delete devDependencies[name];
    }
    pinNxFamily(dependencies);
    pinNxFamily(devDependencies);
    if (Object.keys(dependencies).length > 0) {
      packageJson.dependencies = sortKeys(dependencies);
    } else {
      delete packageJson.dependencies;
    }
    packageJson.devDependencies = sortKeys(devDependencies);
    if (settings.allowScripts) {
      packageJson.allowScripts = {
        ...settings.allowScripts,
        ...packageJson.allowScripts,
      };
    }
    if (settings.overrides) {
      packageJson.overrides = {
        ...settings.overrides,
        ...packageJson.overrides,
      };
    }
    return packageJson;
  });
}
