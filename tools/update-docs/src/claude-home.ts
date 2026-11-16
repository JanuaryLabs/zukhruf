import { join } from 'node:path';

import { under } from './paths.ts';

/** The ~/.claude folder of the user the tool runs for. */
export class ClaudeHome {
  readonly root: string;

  constructor(home: string) {
    this.root = join(home, '.claude');
  }

  /** The folder of one transcript folder per working directory. */
  get projects(): string {
    return join(this.root, 'projects');
  }

  /** The folder this tool keeps its config, ledger and run reports in. */
  get state(): string {
    return join(this.root, 'plans', 'update-docs');
  }

  /** A session that ran here was a tool or hook run, not the user's work. */
  holds(path: string): boolean {
    return under(path, this.root);
  }
}
