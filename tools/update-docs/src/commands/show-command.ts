import type { Ledger } from '../ledger/ledger.ts';
import type { Workspace } from '../workspace/workspace.ts';
import type { Outcome } from './outcome.ts';

/**
 * Prints one project's ledger entry, which a run reads at its start to carry
 * forward the items that still hold.
 */
export class ShowCommand {
  readonly #workspace: Workspace;

  constructor(workspace: Workspace) {
    this.#workspace = workspace;
  }

  async run(name: string, ledger: Ledger): Promise<Outcome> {
    const project = await this.#workspace.project(name);
    const run = ledger.runs.get(project.name);
    return {
      exitCode: 0,
      stdout: `${JSON.stringify(run ?? { state: 'never-run' }, null, 2)}\n`,
    };
  }
}
