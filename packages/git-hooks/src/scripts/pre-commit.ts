import { Commit } from '../commit.ts';
import type { Step } from '../step.ts';
import { Host } from './host.ts';

// What a repo's `.husky/pre-commit.ts` calls.
export async function preCommit(steps: readonly Step<Commit>[]): Promise<void> {
  const host = new Host();
  const commit = new Commit(
    host.root,
    host.hookEnvironment,
    await host.toolEnvironment(),
  );
  for (const step of steps) {
    const outcome = await step.run(commit);
    host.print(step.name, outcome.message);
    if (outcome.kind === 'fail')
      return host.stop('commit stopped by the pre-commit hook');
  }
}
