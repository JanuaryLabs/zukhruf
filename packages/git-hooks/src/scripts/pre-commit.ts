import { Commit } from '../commit.ts';
import type { Step } from '../step.ts';

// What a repo's `.husky/pre-commit.ts` calls. Git runs the hook at the root of
// the work tree, so the current folder is the repo. This is the one module
// that prints and reads the environment, as a script may.
export async function preCommit(steps: readonly Step[]): Promise<void> {
  const commit = new Commit(process.cwd(), process.env);
  for (const step of steps) {
    const outcome = await step.run(commit);
    const [first = '', ...rest] = outcome.message.split('\n');
    console.error(`${step.name.padEnd(9)} ${first}`);
    for (const line of rest) console.error(`${' '.repeat(10)}${line}`);
    if (outcome.kind === 'fail') {
      console.error('✖ commit stopped by the pre-commit hook');
      process.exitCode = 1;
      return;
    }
  }
}
