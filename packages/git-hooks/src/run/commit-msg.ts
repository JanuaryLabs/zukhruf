import { CommitMessage } from '../commit-message.ts';
import type { Step } from '../step.ts';
import { type HookRun, StepRunner, type StepsResult } from './step-runner.ts';

interface CommitMsgRun extends HookRun {
  // The file that holds the message: the argument of the hook.
  readonly file: string;
}

// Runs the steps of a commit-msg hook on the message in `file`.
export async function runCommitMsg(
  { root, hookEnvironment, print, file }: CommitMsgRun,
  steps: readonly Step<CommitMessage>[],
): Promise<StepsResult> {
  const message = await CommitMessage.read(root, hookEnvironment, file);
  return new StepRunner(print).run(message, steps);
}
