import { text } from 'node:stream/consumers';

import { Push } from '../push.ts';
import type { Step } from '../step.ts';

// What a repo's `.husky/pre-push.ts` calls. Git runs the hook at the root of
// the work tree, with the name and the URL of the remote as arguments and one
// ref update on each line of the standard input. This is the one module that
// prints and reads the arguments, the input and the environment, as a script
// may.
export async function prePush(steps: readonly Step<Push>[]): Promise<void> {
  let current = '';
  const print = (name: string, message: string) => {
    const [first = '', ...rest] = message.split('\n');
    console.error(`${name.padEnd(9)} ${first}`);
    for (const line of rest) console.error(`${' '.repeat(10)}${line}`);
  };
  const [name = '', url = ''] = process.argv.slice(2);
  const push = await Push.read({
    root: process.cwd(),
    environment: process.env,
    remote: { name, url },
    input: await text(process.stdin),
    notice: (message) => print(current, message),
  });
  for (const step of steps) {
    current = step.name;
    const outcome = await step.run(push);
    print(step.name, outcome.message);
    if (outcome.kind === 'fail') {
      console.error('✖ push stopped by the pre-push hook');
      process.exitCode = 1;
      return;
    }
  }
}
