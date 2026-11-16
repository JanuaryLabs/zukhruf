import { gitIn } from '../git.ts';
import { Push } from '../push.ts';
import { Snapshots } from '../snapshot/snapshots.ts';
import type { Step } from '../step.ts';
import { Host } from './host.ts';

// What a repo's `.husky/pre-push.ts` calls. Git gives the hook the name and
// the URL of the remote as arguments, and one ref update on each line of the
// standard input. The snapshots that the steps open are deleted after the
// last step, also when a step fails or throws.
export async function prePush(steps: readonly Step<Push>[]): Promise<void> {
  const host = new Host();
  let current = '';
  const [name = '', url = ''] = host.arguments;
  await using snapshots = new Snapshots({
    hook: 'pre-push',
    root: host.root,
    git: gitIn(host.root, host.hookEnvironment),
    toolEnvironment: await host.toolEnvironment(),
    notice: (message) => host.print(current, message),
    clock: globalThis,
  });
  const push = await Push.read({
    root: host.root,
    environment: host.hookEnvironment,
    snapshots,
    remote: { name, url },
    input: await host.input(),
  });
  for (const step of steps) {
    current = step.name;
    const outcome = await step.run(push);
    host.print(step.name, outcome.message);
    if (outcome.kind === 'fail')
      return host.stop('push stopped by the pre-push hook');
  }
}
