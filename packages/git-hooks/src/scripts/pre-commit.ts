import { Commit } from '../commit.ts';
import { gitIn } from '../git.ts';
import { Snapshots } from '../snapshot/snapshots.ts';
import type { Step } from '../step.ts';
import { Host } from './host.ts';

// What a repo's `.husky/pre-commit.ts` calls. The snapshots that the steps
// open are deleted after the last step, also when a step fails or throws.
// When every step passed or skipped, the index must still hold the tree that
// the steps judged, with what they generated: another session that runs
// `git add` while the hook runs would put an unjudged change in the commit.
export async function preCommit(steps: readonly Step<Commit>[]): Promise<void> {
  const host = new Host();
  let current = '';
  await using snapshots = new Snapshots({
    hook: 'pre-commit',
    root: host.root,
    git: gitIn(host.root, host.hookEnvironment),
    toolEnvironment: await host.toolEnvironment(),
    notice: (message) => host.print(current, message),
    clock: globalThis,
  });
  let judged: string;
  const commit = new Commit({
    root: host.root,
    environment: host.hookEnvironment,
    snapshots,
    notice: (message) => host.print(current, message),
    generated: (tree) => {
      judged = tree;
    },
  });
  judged = (await commit.tree()).id;
  for (const step of steps) {
    current = step.name;
    const outcome = await step.run(commit);
    host.print(step.name, outcome.message);
    if (outcome.kind === 'fail')
      return host.stop('commit stopped by the pre-commit hook');
  }
  if ((await commit.tree()).id !== judged)
    return host.stop(
      'the index changed while the hook ran: another git command staged a change that the steps did not judge; commit again',
    );
}
