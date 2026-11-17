import type { Commit } from '../commit.ts';
import { runPreCommit } from '../run/pre-commit.ts';
import type { Step } from '../step.ts';
import { Host } from './host.ts';

// What a repo's `.husky/pre-commit.ts` calls.
export async function preCommit(steps: readonly Step<Commit>[]): Promise<void> {
  const host = new Host();
  const result = await runPreCommit(
    {
      root: host.root,
      hookEnvironment: host.hookEnvironment,
      toolEnvironment: await host.toolEnvironment(),
      print: (name, message) => host.print(name, message),
    },
    steps,
  );
  if (result.kind === 'failed')
    host.stop('commit stopped by the pre-commit hook');
  if (result.kind === 'stopped') host.stop(result.reason);
}
