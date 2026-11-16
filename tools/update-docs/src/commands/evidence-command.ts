import type { EvidenceBudget } from '../evidence/evidence-budget.ts';
import type { Evidence } from '../evidence/evidence.ts';
import type { Since } from '../since.ts';
import type { Workspace } from '../workspace/workspace.ts';
import type { Outcome } from './outcome.ts';

/**
 * Prints one project's evidence bundle, one JSON record per line, cut to the
 * size an agent reads whole.
 */
export class EvidenceCommand {
  readonly #workspace: Workspace;
  readonly #evidence: Evidence;
  readonly #budget: EvidenceBudget;

  constructor(
    workspace: Workspace,
    evidence: Evidence,
    budget: EvidenceBudget,
  ) {
    this.#workspace = workspace;
    this.#evidence = evidence;
    this.#budget = budget;
  }

  async run(name: string, since: Since): Promise<Outcome> {
    const project = await this.#workspace.project(name);
    const collected = await this.#evidence.collect([{ project, since }]);
    const records = this.#budget.cut(collected.get(project.name) ?? []);
    return {
      exitCode: 0,
      stdout: records.map((record) => `${JSON.stringify(record)}\n`).join(''),
    };
  }
}
