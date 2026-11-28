import { Command, ExitError } from '@zukhruf/process';

import { Service } from './service.ts';

// A service whose status a framework of macOS gives.
export abstract class PromptedService<Status extends string> extends Service {
  abstract status(): Status;

  // The JXA script that asks macOS for this service (ADR 0007).
  protected abstract readonly requestScript: string;

  // Asks macOS to show its prompt, and resolves with the status after the
  // user answered. macOS asks only while the status is not decided. The
  // signal ends osascript, and the promise rejects with its reason.
  async request({ signal }: { readonly signal: AbortSignal }): Promise<Status> {
    signal.throwIfAborted();
    const osascript = new Command(
      '/usr/bin/osascript',
      ['-l', 'JavaScript', '-e', this.requestScript],
      { env: {}, clock: globalThis },
    );
    const run = await osascript.run({ signal });
    if (run.exitCode !== 0) throw new ExitError('osascript', run);
    return this.status();
  }

  // Apple's raw value as its name, in the order of the SDK header.
  protected named(names: readonly Status[], raw: number): Status {
    const name = names[raw];
    if (name === undefined)
      throw new RangeError(`${this.name} gave the unknown status ${raw}`);
    return name;
  }
}
