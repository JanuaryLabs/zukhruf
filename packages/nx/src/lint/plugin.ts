import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type CreateNodes,
  type CreateNodesContext,
  type TargetConfiguration,
  createNodesFromFiles,
  readJsonFile,
} from '@nx/devkit';

import { projectRootFiles } from '../project-roots.ts';

const eslintPlugin = '@nx/eslint/plugin';

/**
 * Adds the packages of `@zukhruf/eslint` to the inputs of the `lint` target
 * that `@nx/eslint/plugin` gives (ADR 0006). It gives no executor and no
 * command, so Nx merges it into that target, and deletes it from a root
 * that has no such target.
 */
export const createNodes: CreateNodes = [
  '{package.json,**/package.json,project.json,**/project.json}',
  (configFiles, options, context) => {
    const names = lintTargetNames(context);
    const lint: TargetConfiguration = {
      inputs: ['...', ...eslintPackageInputs(context.workspaceRoot)],
    };
    return createNodesFromFiles(
      (file) => ({
        projects: {
          [dirname(file)]: {
            targets: Object.fromEntries(names.map((name) => [name, lint])),
          },
        },
      }),
      projectRootFiles(configFiles, context.workspaceRoot),
      options,
      context,
    );
  },
];

// A plugin sees neither the targets of another plugin nor its own entry
// (`public-api.d.ts:6-9`), and a later plugin wins the merge. So this plugin
// finds its own entries the way Nx resolves a plugin
// (`in-process-loader.js:42,51`) and checks that each `@nx/eslint/plugin`
// entry comes first. A wrong order loses the inputs with no message.
function lintTargetNames({
  nxJsonConfiguration,
  workspaceRoot,
}: CreateNodesContext) {
  // `plugins` is optional in `nx-json.d.ts`; with no list, this plugin is
  // not listed, and the check below stops.
  const entries = (nxJsonConfiguration.plugins ?? []).map((entry) =>
    typeof entry === 'string' ? { plugin: entry } : entry,
  );
  const self = fileURLToPath(import.meta.url);
  const paths = [join(workspaceRoot, '.nx', 'installation'), workspaceRoot];
  const eslintEntries = entries.filter(
    (entry) => entry.plugin === eslintPlugin,
  );
  const eslintIndexes = entries.flatMap((entry, index) =>
    entry.plugin === eslintPlugin ? [index] : [],
  );
  const selfIndexes = entries.flatMap((entry, index) =>
    entry.plugin !== eslintPlugin && resolvesTo(entry.plugin, paths, self)
      ? [index]
      : [],
  );
  if (
    selfIndexes.length === 0 ||
    eslintEntries.length === 0 ||
    Math.max(...eslintIndexes) > Math.min(...selfIndexes)
  ) {
    throw new Error(
      `@zukhruf/nx/lint must come after each ${eslintPlugin} entry in the plugins of nx.json, or the lint inputs are lost. List @zukhruf/nx/lint after each ${eslintPlugin} entry. A workspace that builds @zukhruf/nx lists this plugin by path, for example "./packages/nx/src/lint/plugin.ts": Nx resolves a package of the workspace by name with the customConditions of the root tsconfig, and this check does not.`,
    );
  }
  // A string entry has no options, and the fallback is the one of
  // `@nx/eslint/plugin` itself (`plugin.js:325`).
  return [...new Set(eslintEntries.map((entry) => targetName(entry.options)))];
}

function targetName(options: unknown) {
  return typeof options === 'object' &&
    options !== null &&
    'targetName' in options &&
    typeof options.targetName === 'string'
    ? options.targetName
    : 'lint';
}

function notFound(error: unknown) {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'MODULE_NOT_FOUND'
  );
}

function resolvesTo(spec: string, paths: string[], self: string) {
  try {
    return createRequire(self).resolve(spec, { paths }) === self;
  } catch (error) {
    // Another entry that Node cannot resolve is not this plugin; Nx reports
    // it on its own.
    if (notFound(error)) {
      return false;
    }
    throw error;
  }
}

// An installed package has a node in the lockfile, and its edges reach each
// peer and dependency (`npm-parser.js:155-170`). A package of the workspace
// has no node (`"link": true`), so its source and its names are the inputs.
function eslintPackageInputs(workspaceRoot: string) {
  const manifest = eslintManifest(workspaceRoot);
  if (manifest.split(sep).includes('node_modules')) {
    return [{ externalDependencies: ['@zukhruf/eslint'] }];
  }
  const folder = relative(realpathSync(workspaceRoot), dirname(manifest));
  if (folder.startsWith('..') || isAbsolute(folder)) {
    throw new Error(
      `@zukhruf/eslint resolves to ${dirname(manifest)}, outside the workspace and outside node_modules, for example through npm link. Nx has no lockfile node for such a package, so @zukhruf/nx/lint cannot hash it. Install @zukhruf/eslint from the registry.`,
    );
  }
  const { dependencies, peerDependencies } = readJsonFile<{
    dependencies: Record<string, string>;
    peerDependencies: Record<string, string>;
  }>(manifest);
  return [
    `{workspaceRoot}/${folder}/src/**/*`,
    {
      externalDependencies: [
        ...Object.keys(dependencies),
        ...Object.keys(peerDependencies),
      ],
    },
  ];
}

// The workspace's ESLint config loads `@zukhruf/eslint`, so it resolves from
// the workspace root.
function eslintManifest(workspaceRoot: string) {
  try {
    return createRequire(join(workspaceRoot, 'package.json')).resolve(
      '@zukhruf/eslint/package.json',
    );
  } catch (error) {
    if (notFound(error)) {
      throw new Error(
        `@zukhruf/nx/lint cannot resolve @zukhruf/eslint from ${workspaceRoot}. Install @zukhruf/eslint: without it, lint has no inputs for its lint packages.`,
        { cause: error },
      );
    }
    throw error;
  }
}
