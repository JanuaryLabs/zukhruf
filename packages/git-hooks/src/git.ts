import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Runs one git command, and gives its standard output.
export type Git = (...args: string[]) => Promise<string>;

// git in `cwd` with `environment`. The standard input of git is closed, so a
// command that reads it, such as `git hash-object --stdin`, reads nothing and
// does not wait.
export function gitIn(cwd: string, environment: NodeJS.ProcessEnv): Git {
  return async (...args) => {
    const git = execFileAsync('git', args, {
      cwd,
      env: environment,
      encoding: 'utf8',
      // A file of any size, not Node's default of 1 MiB.
      maxBuffer: 2 ** 30,
    });
    git.child.stdin?.end();
    return (await git).stdout;
  };
}
