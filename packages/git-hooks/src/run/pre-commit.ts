import { Commit } from '../commit.ts';
import { gitIn } from '../git.ts';
import { Snapshots } from '../snapshot/snapshots.ts';
import type { Step } from '../step.ts';
import { type HookRun, StepRunner, type StepsResult } from './step-runner.ts';

// What the pre-commit hook gave: the result of its steps, or, when every
// step passed or skipped, a stop for a reason that no step gave.
export type PreCommitResult =
  | StepsResult
  | {
      readonly kind: 'stopped';
      readonly outcomes: StepsResult['outcomes'];
      readonly reason: string;
    };

interface PreCommitRun extends HookRun {
  // The hook environment without the git variables of the repo, for tools.
  readonly toolEnvironment: NodeJS.ProcessEnv;
}

// Runs the steps of a pre-commit hook on the staged commit. The snapshots
// that the steps open are deleted after the last step, also when a step fails
// or throws. When every step passed or skipped, the index must still hold the
// tree that the steps judged, with what they generated: another session that
// runs `git add` while the hook runs would put an unjudged change in the
// commit.
export async function runPreCommit(
  { root, hookEnvironment, toolEnvironment, print }: PreCommitRun,
  steps: readonly Step<Commit>[],
): Promise<PreCommitResult> {
  const runner = new StepRunner(print);
  await using snapshots = new Snapshots({
    hook: 'pre-commit',
    root,
    git: gitIn(root, hookEnvironment),
    toolEnvironment,
    notice: runner.notice,
    clock: globalThis,
  });
  let judged: string;
  const commit = new Commit({
    root,
    environment: hookEnvironment,
    snapshots,
    notice: runner.notice,
    generated: (tree) => {
      judged = tree;
    },
  });
  judged = (await commit.tree()).id;
  const result = await runner.run(commit, steps);
  if (result.kind === 'failed' || (await commit.tree()).id === judged)
    return result;
  return {
    kind: 'stopped',
    outcomes: result.outcomes,
    reason:
      'the index changed while the hook ran: another git command staged a change that the steps did not judge; commit again',
  };
}
