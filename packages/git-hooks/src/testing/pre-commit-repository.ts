import { execFile } from 'node:child_process';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageEntry = import.meta.resolve('../index.ts');

// A git repo in a temp folder whose hook is `.husky/<name>.ts`, reached
// through the committed link `.husky/<name>`, as a repo installs it. git and
// the hook see none of the user's git config and no environment of the Nx task
// that runs this test.
export async function repository(
  root: string,
  hook: string,
  name: 'pre-commit' | 'commit-msg' = 'pre-commit',
) {
  const environment = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: root,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  const git = async (...args: string[]) =>
    (await execFileAsync('git', args, { cwd: root, env: environment })).stdout;
  await git('init', '--quiet', '--initial-branch=main');
  await writeFile(join(root, 'package.json'), '{ "type": "module" }\n');
  await writeFile(join(root, '.prettierrc'), '{ "singleQuote": true }\n');
  await mkdir(join(root, '.husky'));
  await writeFile(
    join(root, `.husky/${name}.ts`),
    `#!/usr/bin/env node\n${hook.replaceAll('@zukhruf/git-hooks', packageEntry)}`,
  );
  await chmod(join(root, `.husky/${name}.ts`), 0o755);
  await symlink(`${name}.ts`, join(root, `.husky/${name}`));
  return {
    root,
    git,
    write: (path: string, content: string) =>
      writeFile(join(root, path), content),
    async commit(message: string) {
      try {
        const { stdout, stderr } = await execFileAsync(
          'git',
          ['-c', 'core.hooksPath=.husky', 'commit', '--quiet', '-m', message],
          { cwd: root, env: environment },
        );
        return { code: 0, stdout, stderr };
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('code' in error) ||
          !('stdout' in error) ||
          !('stderr' in error)
        )
          throw error;
        return {
          code: Number(error.code),
          stdout: String(error.stdout),
          stderr: String(error.stderr),
        };
      }
    },
  };
}
