import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  hookedGit,
  installHook,
  isolatedEnvironment,
} from './hooked-repository.ts';

const execFileAsync = promisify(execFile);

// A git repo in a temp folder with a pre-push hook and a bare remote `origin`
// beside it. `extraEnvironment` reaches each git command and the hook.
export async function repository(
  top: string,
  hook: string,
  extraEnvironment: Readonly<Record<string, string>> = {},
) {
  const root = join(top, 'repo');
  const remote = join(top, 'remote.git');
  await mkdir(root);
  await mkdir(join(top, 'home'));
  const environment = {
    ...isolatedEnvironment(join(top, 'home')),
    ...extraEnvironment,
  };
  const gitIn = async (cwd: string, ...args: string[]) =>
    (await execFileAsync('git', args, { cwd, env: environment })).stdout;
  const git = (...args: string[]) => gitIn(root, ...args);
  await gitIn(
    top,
    'init',
    '--quiet',
    '--bare',
    '--initial-branch=main',
    remote,
  );
  await git('init', '--quiet', '--initial-branch=main');
  await git('remote', 'add', 'origin', remote);
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  await installHook(root, 'pre-push', hook);
  const pushWith = (gitOptions: readonly string[], ...args: string[]) =>
    hookedGit(['-c', 'core.hooksPath=.husky', ...gitOptions, 'push', ...args], {
      cwd: root,
      env: environment,
    });
  return {
    top,
    root,
    remote,
    environment,
    git,
    gitIn,
    async write(path: string, content: string) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    },
    async commit(message: string) {
      await git('add', '--all');
      await git('commit', '--quiet', '--no-verify', '-m', message);
      return (await git('rev-parse', 'HEAD')).trim();
    },
    pushWith,
    push: (...args: string[]) => pushWith([], ...args),
  };
}
