import { execFile } from 'node:child_process';
import { chmod, mkdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageEntry = import.meta.resolve('../index.ts');

// git and the hook see none of the user's git config and no environment of the
// Nx task that runs this test.
export function isolatedEnvironment(home: string) {
  return {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    HOME: home,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

// The hook is `.husky/<name>.ts`, reached through the committed link
// `.husky/<name>`, as a repo installs it.
export async function installHook(root: string, name: string, hook: string) {
  await mkdir(join(root, '.husky'));
  await writeFile(
    join(root, `.husky/${name}.ts`),
    `#!/usr/bin/env node\n${hook.replaceAll('@zukhruf/git-hooks', packageEntry)}`,
  );
  await chmod(join(root, `.husky/${name}.ts`), 0o755);
  await symlink(`${name}.ts`, join(root, `.husky/${name}`));
}

// Runs a git command that a hook can refuse: the refusal is an exit code and
// its output, and each other error stays an error.
export async function hookedGit(
  args: readonly string[],
  options: { readonly cwd: string; readonly env: NodeJS.ProcessEnv },
) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, options);
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (
      !Error.isError(error) ||
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
}
