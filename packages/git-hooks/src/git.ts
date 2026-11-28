import { Command, ExitError } from '@zukhruf/process';

// Runs one git command, and gives its standard output.
export type Git = (...args: string[]) => Promise<string>;

// git in `cwd` with `environment`. `input` goes to the standard input of git,
// and then it ends. Without `input` it ends at once, so a command that reads
// it, such as `git hash-object --stdin`, reads nothing and does not wait. An
// end other than exit code 0 throws an ExitError.
export function gitIn(
  cwd: string,
  environment: NodeJS.ProcessEnv,
  input?: string,
): Git {
  return async (...args) => {
    const run = await new Command('git', args, {
      env: environment,
      clock: globalThis,
      cwd,
    }).run(input === undefined ? {} : { input });
    if (run.exitCode !== 0) throw new ExitError('git', run);
    return run.stdout;
  };
}
