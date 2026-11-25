import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Client } from './client.ts';

const run = promisify(execFile);

// A kind of grant that TCC keeps, with the pane of System Settings where the
// user turns a client on (TCCServiceList.plist of SecurityPrivacyExtension).
export abstract class Service {
  abstract readonly name: string;
  abstract readonly pane: string;
  protected abstract readonly anchor: string;

  get url(): URL {
    return new URL(
      `x-apple.systempreferences:com.apple.preference.security?${this.anchor}`,
    );
  }

  remedy(client: Client): string {
    return `Turn on ${client.name} in System Settings › Privacy & Security › ${this.pane}.`;
  }

  async openSettings(): Promise<void> {
    await run('/usr/bin/open', [this.url.href]);
  }
}
