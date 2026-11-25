import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

import type { Client } from './client.ts';

const run = promisify(execFile);

// The strings of the Privacy & Security pane of System Settings, by key.
const strings =
  '/System/Library/ExtensionKit/Extensions/SecurityPrivacyExtension.appex/Contents/Resources/Localizable.loctable';

// A kind of grant that TCC keeps, with the pane of System Settings where the
// user turns a client on (TCCServiceList.plist of SecurityPrivacyExtension).
export abstract class Service {
  abstract readonly name: string;
  // The key of the pane's title in the strings of System Settings.
  protected abstract readonly paneKey: string;
  protected abstract readonly anchor: string;

  // The title of the pane as System Settings of this Mac shows it. macOS
  // renames panes: Accessibility on macOS 26 is "Device Control and Data
  // Access" on macOS 27 (ADR 0005).
  get pane(): string {
    return execFileSync(
      '/usr/bin/plutil',
      ['-extract', `en.${this.paneKey}`, 'raw', '-o', '-', strings],
      { encoding: 'utf8' },
    ).trimEnd();
  }

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
