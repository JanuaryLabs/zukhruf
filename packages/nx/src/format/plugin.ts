import { basename, dirname, isAbsolute, join } from 'node:path';

import {
  type CreateNodes,
  type TargetConfiguration,
  createNodesFromFiles,
  readJsonFile,
} from '@nx/devkit';
import {
  buildPackageJsonPatterns,
  buildPackageJsonWorkspacesMatcher,
} from '@nx/devkit/internal';
import { resolveConfig } from 'prettier';

/**
 * Gives each Nx project `format` (writes) and `format:check` (only reads,
 * cached). Any root that a plugin returns becomes a project, and no plugin
 * hook receives the projects that Nx found. So the plugin selects roots with
 * the rule and the matcher of Nx's own package.json plugin: each folder with a
 * `project.json`, and a `package.json` folder only when the package-manager
 * workspace globs match it. It returns targets only; the default plugins name
 * the project.
 */
export const createNodes: CreateNodes = [
  '{package.json,**/package.json,project.json,**/project.json}',
  async (configFiles, options, context) => {
    const projectJsonRoots = new Set(
      configFiles
        .filter((file) => basename(file) === 'project.json')
        .map((file) => dirname(file)),
    );
    const isInWorkspaces = buildPackageJsonWorkspacesMatcher(
      buildPackageJsonPatterns(context.workspaceRoot, (file: string) =>
        readJsonFile(join(context.workspaceRoot, file)),
      ),
    );
    const rootFiles = configFiles.filter((file) =>
      basename(file) === 'project.json'
        ? true
        : !projectJsonRoots.has(dirname(file)) && isInWorkspaces(file),
    );
    const formatCheck: TargetConfiguration = {
      command: 'prettier --check --no-error-on-unmatched-pattern {projectRoot}',
      cache: true,
      inputs: [
        'default',
        '{workspaceRoot}/.prettierrc*',
        '{workspaceRoot}/.prettierignore',
        {
          externalDependencies: [
            'prettier',
            ...(await prettierPlugins(context.workspaceRoot)),
          ],
        },
      ],
    };
    return createNodesFromFiles(
      (file) => ({
        projects: {
          [dirname(file)]: {
            targets: {
              format: { command: 'prettier --write {projectRoot}' },
              'format:check': formatCheck,
            },
          },
        },
      }),
      rootFiles,
      options,
      context,
    );
  },
];

async function prettierPlugins(workspaceRoot: string) {
  // `Options.plugins` is optional, and `resolveConfig` gives null when no
  // config file exists (prettier/index.d.ts:649-652, 807).
  const plugins = (await resolveConfig(join(workspaceRoot, 'package.json')))
    ?.plugins;
  return (plugins ?? [])
    .filter(
      (plugin): plugin is string =>
        typeof plugin === 'string' &&
        !plugin.startsWith('.') &&
        !isAbsolute(plugin),
    )
    .map((plugin) =>
      plugin
        .split('/')
        .slice(0, plugin.startsWith('@') ? 2 : 1)
        .join('/'),
    );
}
