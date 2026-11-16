import { Commit } from '../commit.ts';
import { gitIn } from '../git.ts';
import { Snapshots } from '../snapshot/snapshots.ts';
import type { Step } from '../step.ts';
import { Host } from './host.ts';

// What a repo's `.husky/pre-commit.ts` calls. The snapshots that the steps
// open are deleted after the last step, also when a step fails or throws.
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
  const commit = new Commit(host.root, host.hookEnvironment, snapshots);
  for (const step of steps) {
    current = step.name;
    const outcome = await step.run(commit);
    host.print(step.name, outcome.message);
    if (outcome.kind === 'fail')
      return host.stop('commit stopped by the pre-commit hook');
  }
}
