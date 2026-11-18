import { symlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

import {
  type GeneratorCallback,
  type Tree,
  formatFiles,
  installPackagesTask,
  runTasksInSerial,
  writeJson,
} from '@nx/devkit';

import { addLines } from '../add-lines.ts';
import { workspaceScope } from '../workspace-scope.ts';
import {
  agents,
  claude,
  editorconfig,
  eslintConfig,
  gitattributes,
  gitignore,
  hooks,
  npmrc,
  nvmrc,
  prettierignore,
  prettierrc,
  tsconfigBase,
  tsconfigSolution,
  vscodeExtensions,
  vscodeSettings,
} from './files.ts';
import { mergeNxJson } from './nx-json.ts';
import { mergeRootPackageJson } from './root-package-json.ts';

/** Writes a file only when it is missing. Returns whether it wrote. */
function create(tree: Tree, path: string, content: string | object): boolean {
  if (tree.exists(path)) return false;
  if (typeof content === 'string') {
    tree.write(path, content);
  } else {
    writeJson(tree, path, content);
  }
  return true;
}

/**
 * Adds the root files of the monorepo standard to an Nx workspace. It creates
 * a missing file, adds missing lines and merges keys, and never deletes. A
 * second run changes nothing. `nx add @zukhruf/nx` runs it.
 */
export default async function initGenerator(
  tree: Tree,
): Promise<GeneratorCallback> {
  const scope = workspaceScope(tree);

  mergeRootPackageJson(tree);
  mergeNxJson(tree);
  create(tree, 'tsconfig.base.json', tsconfigBase);
  create(tree, 'tsconfig.json', tsconfigSolution);
  addLines(tree, '.npmrc', npmrc);
  create(tree, '.nvmrc', nvmrc);
  create(tree, '.gitattributes', gitattributes);
  create(tree, '.editorconfig', editorconfig);
  addLines(tree, '.gitignore', gitignore);
  create(tree, '.prettierrc', prettierrc(scope));
  addLines(tree, '.prettierignore', prettierignore);
  create(tree, 'eslint.config.mjs', eslintConfig);
  const newHooks = Object.entries(hooks)
    .filter(([path, content]) => create(tree, path, content))
    .map(([path]) => path);
  create(tree, '.vscode/settings.json', vscodeSettings);
  create(tree, '.vscode/extensions.json', vscodeExtensions);
  create(tree, 'AGENTS.md', agents);
  create(tree, 'CLAUDE.md', claude);

  await formatFiles(tree);
  // formatFiles writes each file again with no mode, so the mode comes after it.
  for (const path of newHooks) {
    tree.changePermissions(path, '755');
  }

  return runTasksInSerial(
    () => installPackagesTask(tree),
    () => linkHooks(tree.root),
  );
}

/**
 * Git runs `.husky/pre-commit`, so it is a link to `pre-commit.ts`. The Tree
 * has no links, so this writes each missing link after Nx writes the files.
 */
async function linkHooks(root: string): Promise<void> {
  for (const path of Object.keys(hooks)) {
    try {
      await symlink(basename(path), join(root, path.replace(/\.ts$/, '')));
    } catch (error) {
      if (!(
        Error.isError(error) &&
        'code' in error &&
        error.code === 'EEXIST'
      )) {
        throw error;
      }
    }
  }
}
