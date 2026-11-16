import { Push } from '../push.ts';
import type { Step } from '../step.ts';
import { Host } from './host.ts';

// What a repo's `.husky/pre-push.ts` calls. Git gives the hook the name and
// the URL of the remote as arguments, and one ref update on each line of the
// standard input.
export async function prePush(steps: readonly Step<Push>[]): Promise<void> {
  const host = new Host();
  let current = '';
  const [name = '', url = ''] = host.arguments;
  const push = await Push.read({
    root: host.root,
    environment: host.hookEnvironment,
    toolEnvironment: await host.toolEnvironment(),
    remote: { name, url },
    input: await host.input(),
    notice: (message) => host.print(current, message),
    clock: globalThis,
  });
  for (const step of steps) {
    current = step.name;
    const outcome = await step.run(push);
    host.print(step.name, outcome.message);
    if (outcome.kind === 'fail')
      return host.stop('push stopped by the pre-push hook');
  }
}
