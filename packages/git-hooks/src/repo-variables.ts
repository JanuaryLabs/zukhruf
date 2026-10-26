import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// The environment without the variables that tie git to one repo, such as
// GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE. A hook gets some of them from
// git, and a tool that the hook starts, such as nx and its tasks, must not
// get them: a task that runs `git init` in its own temp folder would then
// write to the repo of the hook. Git gives the list with
// `git rev-parse --local-env-vars`, and clears the same list when it runs a
// command in another repo, such as a submodule.
export async function withoutRepoVariables(
  environment: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const { stdout } = await execFileAsync(
    'git',
    ['rev-parse', '--local-env-vars'],
    { env: environment, encoding: 'utf8' },
  );
  const names = new Set(stdout.split('\n'));
  return Object.fromEntries(
    Object.entries(environment).filter(([name]) => !names.has(name)),
  );
}
