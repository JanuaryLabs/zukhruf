import type { Evidence } from '../evidence/evidence.ts';
import type { Ledger } from '../ledger/ledger.ts';
import { Since } from '../since.ts';
import type { Workspace } from '../workspace/workspace.ts';
import type { Outcome } from './outcome.ts';

/**
 * Prints the projects with new evidence since their last run, and the
 * projects that never ran. Consumer call sites are today's state, not news,
 * so only consumer commits count.
 */
export class DeltaCommand {
  readonly #workspace: Workspace;
  readonly #evidence: Evidence;

  constructor(workspace: Workspace, evidence: Evidence) {
    this.#workspace = workspace;
    this.#evidence = evidence;
  }

  async run(ledger: Ledger): Promise<Outcome> {
    const projects = await this.#workspace.projects();
    const ran = projects.flatMap((project) => {
      const run = ledger.runs.get(project.name);
      return run === undefined ? [] : [{ project, lastRun: run.lastRun }];
    });
    const collected = await this.#evidence.collect(
      ran.map(({ project, lastRun }) => ({
        project,
        since: Since.from(Temporal.Instant.from(lastRun)),
      })),
    );
    const changed = ran.flatMap(({ project, lastRun }) => {
      const records = collected.get(project.name) ?? [];
      const count = (source: string) =>
        records.filter((record) => record.source === source).length;
      const counts = {
        packageCommit: count('package-commit'),
        consumerCommit: count('consumer-commit'),
        transcript: count('transcript'),
      };
      return Object.values(counts).some((value) => value > 0)
        ? [{ project: project.name, lastRun, counts }]
        : [];
    });
    const neverRun = projects
      .filter((project) => !ledger.runs.has(project.name))
      .map((project) => project.name);
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ changed, neverRun }, null, 2)}\n`,
    };
  }
}
