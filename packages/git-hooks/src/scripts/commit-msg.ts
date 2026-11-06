import { CommitMessage } from '../commit-message.ts';
import type { Step } from '../step.ts';

// What a repo's `.husky/commit-msg.ts` calls. Git runs the hook at the root of
// the work tree, with the file that holds the message as its argument. This is
// the one module that prints and reads the arguments and the environment, as
// a script may.
export async function commitMsg(
  steps: readonly Step<CommitMessage>[],
): Promise<void> {
  const [file = ''] = process.argv.slice(2);
  const message = await CommitMessage.read(process.cwd(), process.env, file);
  for (const step of steps) {
    const outcome = await step.run(message);
    const [first = '', ...rest] = outcome.message.split('\n');
    console.error(`${step.name.padEnd(9)} ${first}`);
    for (const line of rest) console.error(`${' '.repeat(10)}${line}`);
    if (outcome.kind === 'fail') {
      console.error('✖ commit stopped by the commit-msg hook');
      process.exitCode = 1;
      return;
    }
  }
}
