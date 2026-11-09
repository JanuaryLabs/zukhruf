import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import {
  hookedGit,
  installHook,
  isolatedEnvironment,
} from './hooked-repository.ts';

const execFileAsync = promisify(execFile);

// A git repo in a temp folder with a hook that a commit runs.
export async function repository(
  root: string,
  hook: string,
  name: 'pre-commit' | 'commit-msg' = 'pre-commit',
) {
  const environment = isolatedEnvironment(root);
  const git = async (...args: string[]) =>
    (await execFileAsync('git', args, { cwd: root, env: environment })).stdout;
  await git('init', '--quiet', '--initial-branch=main');
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  await writeFile(join(root, '.prettierrc'), '{ "singleQuote": true }\n');
  await installHook(root, name, hook);
  return {
    root,
    git,
    write: (path: string, content: string) =>
      writeFile(join(root, path), content),
    commit: (message: string, ...gitOptions: string[]) =>
      hookedGit(
        [
          '-c',
          'core.hooksPath=.husky',
          ...gitOptions,
          'commit',
          '--quiet',
          '-m',
          message,
        ],
        { cwd: root, env: environment },
      ),
  };
}
