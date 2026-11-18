import {
  type GeneratorCallback,
  type Tree,
  updateJson,
  writeJson,
} from '@nx/devkit';

import {
  editorconfig,
  gitignore,
  readme,
  vscodeExtensions,
} from '../init/files.ts';
import initGenerator from '../init/generator.ts';
import type { RootPackageJson } from '../init/root-package-json.ts';

export interface PresetOptions {
  /** The folder name, from create-nx-workspace. */
  name: string;
  /** Anything other than `npm` is an error. */
  packageManager?: string;
}

/**
 * Starts a repo of the monorepo standard. create-nx-workspace runs it just
 * after `nx new`, so each file in the folder came from `nx new`: it replaces 4
 * of them, cleans package.json, and then runs `init`.
 */
export default async function presetGenerator(
  tree: Tree,
  options: PresetOptions,
): Promise<GeneratorCallback> {
  if (
    options.packageManager !== undefined &&
    options.packageManager !== 'npm'
  ) {
    throw new Error(
      `The monorepo standard uses npm workspaces only, not ${options.packageManager}. Run create-nx-workspace again with --pm=npm.`,
    );
  }

  tree.write('.gitignore', gitignore);
  tree.write('.editorconfig', editorconfig);
  writeJson(tree, '.vscode/extensions.json', vscodeExtensions);
  tree.write('README.md', readme(options.name));
  // `nx g` writes these two into the Tree before it calls a generator named
  // preset (nx/dist/src/command-line/generate/generate.js:250-253, 24.0.6).
  // The standard has no libs/ folder.
  tree.delete('apps/.gitkeep');
  tree.delete('libs/.gitkeep');

  updateJson(tree, 'package.json', (packageJson: RootPackageJson) => {
    // NoNumericPins of @zukhruf/git-hooks refuses a version written as a
    // number, so the first commit would stop on it.
    delete packageJson.packageManager;
    const preset = packageJson.dependencies?.['@zukhruf/nx'];
    if (preset !== undefined) {
      packageJson.devDependencies = {
        ...packageJson.devDependencies,
        '@zukhruf/nx': preset,
      };
      delete packageJson.dependencies?.['@zukhruf/nx'];
    }
    if (Object.keys(packageJson.dependencies ?? {}).length === 0) {
      delete packageJson.dependencies;
    }
    delete packageJson.devDependencies?.['@nx/workspace'];
    return packageJson;
  });

  return initGenerator(tree);
}
