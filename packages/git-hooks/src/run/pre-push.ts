import { gitIn } from '../git.ts';
import { Push } from '../push.ts';
import { Snapshots } from '../snapshot/snapshots.ts';
import type { Step } from '../step.ts';
import { type HookRun, StepRunner, type StepsResult } from './step-runner.ts';

interface PrePushRun extends HookRun {
  // The hook environment without the git variables of the repo, for tools.
  readonly toolEnvironment: NodeJS.ProcessEnv;
  // The name and the URL of the remote: the arguments of the hook.
  readonly remote: { readonly name: string; readonly url: string };
  // The standard input of the hook: one line for each ref update.
  readonly input: string;
}

// Runs the steps of a pre-push hook on the push. The snapshots that the steps
// open are deleted after the last step, also when a step fails or throws.
export async function runPrePush(
  { root, hookEnvironment, toolEnvironment, print, remote, input }: PrePushRun,
  steps: readonly Step<Push>[],
): Promise<StepsResult> {
  const runner = new StepRunner(print);
  await using snapshots = new Snapshots({
    hook: 'pre-push',
    root,
    git: gitIn(root, hookEnvironment),
    toolEnvironment,
    notice: runner.notice,
    clock: globalThis,
  });
  const push = await Push.read({
    root,
    environment: hookEnvironment,
    snapshots,
    remote,
    input,
  });
  // Awaited here, so the snapshots stay open until the last step ends.
  return await runner.run(push, steps);
}
