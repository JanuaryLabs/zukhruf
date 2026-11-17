import type { Push } from '../push.ts';
import { runPrePush } from '../run/pre-push.ts';
import type { Step } from '../step.ts';
import { Host } from './host.ts';

// What a repo's `.husky/pre-push.ts` calls. Git gives the hook the name and
// the URL of the remote as arguments, and one ref update on each line of the
// standard input.
export async function prePush(steps: readonly Step<Push>[]): Promise<void> {
  const host = new Host();
  const [name = '', url = ''] = host.arguments;
  const { kind } = await runPrePush(
    {
      root: host.root,
      hookEnvironment: host.hookEnvironment,
      toolEnvironment: await host.toolEnvironment(),
      print: (step, message) => host.print(step, message),
      remote: { name, url },
      input: await host.input(),
    },
    steps,
  );
  if (kind === 'failed') host.stop('push stopped by the pre-push hook');
}
