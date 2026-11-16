import { text } from 'node:stream/consumers';

import { withoutRepoVariables } from '../repo-variables.ts';

// The process of a hook: what git gives it, and where its outcomes go. This
// is the one module that reads the process: the current folder, the
// arguments, the standard input and the environment. Git runs a hook at the
// top of the working tree. The environment that git gives the hook is the
// hook environment: the git commands of the hook on the repo get it, so they
// read and write the index of the commit. A step never gets an environment.
export class Host {
  readonly root = process.cwd();
  readonly arguments = process.argv.slice(2);
  readonly hookEnvironment: NodeJS.ProcessEnv = { ...process.env };

  // The environment of each tool: the hook environment without each variable
  // that `git rev-parse --local-env-vars` lists, as git clears them when it
  // runs a command in another repo (githooks(5)). A tool that runs git in a
  // folder of its own then does not reach the repo of the hook.
  toolEnvironment(): Promise<NodeJS.ProcessEnv> {
    return withoutRepoVariables(this.hookEnvironment);
  }

  // The standard input. Git gives one only to the pre-push hook.
  input(): Promise<string> {
    return text(process.stdin);
  }

  // Prints a message of a step under its name, with its next lines indented.
  print(name: string, message: string): void {
    const [first = '', ...rest] = message.split('\n');
    console.error(`${name.padEnd(9)} ${first}`);
    for (const line of rest) console.error(`${' '.repeat(10)}${line}`);
  }

  // Stops the commit or the push: git reads the exit code of the hook.
  stop(reason: string): void {
    console.error(`✖ ${reason}`);
    process.exitCode = 1;
  }
}
