import { basename, resolve } from 'node:path';

import type { Tree } from '@nx/devkit';
import { ESLint } from 'eslint';
import { defineConfig } from 'eslint/config';

import zukhruf from '@zukhruf/eslint';
import { manifest } from '@zukhruf/eslint/nx';

import { changes } from './generator-tree.ts';

const MANIFESTS = new Set(['package.json', 'project.json']);

// A folder that does not exist, so no rule finds a workspace root above the
// linted path and reads this repo's files instead of the Tree's.
const CWD = resolve('/generator-tree');

// The blocks of a generated eslint.config.mjs (init's eslintConfig) that set
// rules on package.json and project.json. Its other blocks set none there.
// `extends` throws when a config is gone, so a renamed one fails the tests.
const config = defineConfig(
  {
    plugins: { zukhruf, manifest },
    extends: ['zukhruf/nx-project-json', 'manifest/recommended'],
  },
  {
    files: ['**/package.json', '**/project.json'],
    rules: {
      // Reads the cached project graph and the installed packages.
      'manifest/dependency-checks': 'off',
      // Checks only the manifest in the workspace root, which it finds by the nx.json on disk.
      'manifest/no-root-script': 'off',
      // Tells the root manifest from the others by the nx.json on disk.
      'manifest/nx-family-pinned': 'off',
      // Reads the root tsconfig.json, tsconfig.base.json and package.json from disk.
      'zukhruf/no-generate-package-json': 'off',
      // Reads the package.json beside the project.json from disk.
      'zukhruf/no-duplicate-nx-key': 'off',
      // Looks for each asset input on disk and reads the root ignore files.
      'zukhruf/no-missing-asset-input': 'off',
      // Reads the cached project graph and the files each script runs.
      'zukhruf/no-missing-dependency-build': 'off',
    },
  },
);

/**
 * The lint messages of each package.json and project.json that the generator
 * created or changed in `tree`, under the manifest rules of @zukhruf/eslint
 * that read the manifest's text alone: `<path>:<line>:<column> <rule> <message>`.
 */
export async function lintManifests(tree: Tree): Promise<string[]> {
  const eslint = new ESLint({
    cwd: CWD,
    overrideConfigFile: true,
    overrideConfig: config,
  });
  const messages: string[] = [];
  for (const [path, content] of changes(tree)) {
    if (content === undefined || !MANIFESTS.has(basename(path))) continue;
    const [result] = await eslint.lintText(content, {
      filePath: resolve(CWD, path),
    });
    for (const message of result?.messages ?? []) {
      messages.push(
        `${path}:${message.line}:${message.column} ${message.ruleId} ${message.message}`,
      );
    }
  }
  return messages;
}
