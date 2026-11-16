import { CommitMessage } from '../commit-message.ts';
import type { Step } from '../step.ts';
import { Host } from './host.ts';

// What a repo's `.husky/commit-msg.ts` calls. Git gives the hook the file that
// holds the message as its argument.
export async function commitMsg(
  steps: readonly Step<CommitMessage>[],
): Promise<void> {
  const host = new Host();
  const [file = ''] = host.arguments;
  const message = await CommitMessage.read(
    host.root,
    host.hookEnvironment,
    file,
  );
  for (const step of steps) {
    const outcome = await step.run(message);
    host.print(step.name, outcome.message);
    if (outcome.kind === 'fail')
      return host.stop('commit stopped by the commit-msg hook');
  }
}
