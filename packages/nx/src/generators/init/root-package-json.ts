import { type Tree, updateJson } from '@nx/devkit';

import { addMissingKeys } from '../add-keys.ts';
import {
  nxFamily,
  nxVersion,
  rootToolVersions,
  zukhrufPackages,
  zukhrufVersion,
} from '../versions.ts';

export interface RootPackageJson {
  name?: string;
  private?: boolean;
  type?: string;
  workspaces?: string[];
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  allowScripts?: Record<string, boolean>;
  overrides?: Record<string, unknown>;
}

// strict-allow-scripts=true in .npmrc fails an install when a package has an
// install script that is not named here. nx checks the platform and updates
// the Nx Cloud client, and no repo uses Nx Cloud. unrs-resolver (through
// eslint-plugin-import-x) ships its binaries prebuilt.
const allowScripts = { nx: false, 'unrs-resolver': false };

/** Sets `nx` and each `@nx/*` of the record to `nxVersion`, also over a newer version (#4532). */
export function pinNxFamily(record: Record<string, string> = {}): void {
  for (const name of Object.keys(record)) {
    if (name === 'nx' || name.startsWith('@nx/')) {
      record[name] = nxVersion;
    }
  }
}

export const sortKeys = (record: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(record).toSorted(([a], [b]) => a.localeCompare(b)),
  );

/**
 * Merges the keys that the standard owns into the root package.json: one
 * exact version for the Nx family, also over another version, and each other
 * root tool when it is missing.
 */
export function mergeRootPackageJson(tree: Tree): void {
  updateJson(tree, 'package.json', (packageJson: RootPackageJson) => {
    packageJson.private = true;
    packageJson.type = 'module';
    packageJson.workspaces ??= ['apps/*', 'packages/*', 'tools/*'];
    packageJson.scripts = addMissingKeys(packageJson.scripts, {
      prepare: 'git config core.hooksPath .husky || exit 0',
    });
    const dependencies = packageJson.dependencies ?? {};
    const devDependencies = { ...packageJson.devDependencies };
    for (const [name, version] of Object.entries({
      ...Object.fromEntries(nxFamily.map((name) => [name, nxVersion])),
      ...Object.fromEntries(
        zukhrufPackages.map((name) => [name, zukhrufVersion]),
      ),
      ...rootToolVersions,
    })) {
      if (!(name in dependencies) && !(name in devDependencies)) {
        devDependencies[name] = version;
      }
    }
    pinNxFamily(dependencies);
    pinNxFamily(devDependencies);
    packageJson.devDependencies = sortKeys(devDependencies);
    packageJson.allowScripts = addMissingKeys(
      packageJson.allowScripts,
      allowScripts,
    );
    return packageJson;
  });
}
