import type { CommitMessage } from '../commit-message.ts';
import { runCommitMsg } from '../run/commit-msg.ts';
import type { Step } from '../step.ts';
import { Host } from './host.ts';

// What a repo's `.husky/commit-msg.ts` calls. Git gives the hook the file that
// holds the message as its argument.
export async function commitMsg(
  steps: readonly Step<CommitMessage>[],
): Promise<void> {
  const host = new Host();
  const [file = ''] = host.arguments;
  const { kind } = await runCommitMsg(
    {
      root: host.root,
      hookEnvironment: host.hookEnvironment,
      print: (name, message) => host.print(name, message),
      file,
    },
    steps,
  );
  if (kind === 'failed') host.stop('commit stopped by the commit-msg hook');
}
