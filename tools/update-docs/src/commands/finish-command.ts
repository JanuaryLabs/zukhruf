import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ReportInvalid } from '../errors.ts';
import { type Git, GitFailed } from '../git.ts';
import type { Ledger, LedgerCommit } from '../ledger/ledger.ts';
import type { RunReport } from '../ledger/run-report.ts';
import type { Workspace } from '../workspace/workspace.ts';
import type { Outcome } from './outcome.ts';

/**
 * Records a finished run. The run's start becomes the project's last run, so
 * evidence that arrived while the run worked is read by the next one.
 */
export class FinishCommand {
  readonly #workspace: Workspace;
  readonly #git: Git;
  readonly #runs: string;

  constructor(workspace: Workspace, git: Git, runs: string) {
    this.#workspace = workspace;
    this.#git = git;
    this.#runs = runs;
  }

  async run(
    name: string,
    started: Temporal.Instant,
    report: RunReport,
    reportFile: string,
    ledger: Ledger,
  ): Promise<Outcome> {
    const project = await this.#workspace.project(name);
    const commits = await this.#commits(report, reportFile);
    await mkdir(this.#runs, { recursive: true });
    // An ISO instant holds colons, which Windows file names cannot.
    const stamp = started.toString().replaceAll(':', '-');
    await writeFile(
      join(this.#runs, `${stamp}-${project.name}.json`),
      report.text,
    );
    await ledger
      .finished(project.name, {
        lastRun: started.toString(),
        commits,
        queued: report.queued,
        open: report.open,
        blocked: report.blocked,
      })
      .write();
    return { exitCode: 0, stdout: '' };
  }

  /** Each reported commit, with its full sha and date from the workspace. */
  async #commits(report: RunReport, file: string): Promise<LedgerCommit[]> {
    return Promise.all(
      report.committed.map(async ({ sha, subject }, index) => {
        try {
          const [full = '', at = ''] = (
            await this.#git.run([
              'show',
              '-s',
              '--format=%H%n%cI',
              '--end-of-options',
              `${sha}^{commit}`,
            ])
          ).split('\n');
          return { sha: full, subject, at };
        } catch (error) {
          if (error instanceof GitFailed) {
            throw new ReportInvalid(
              file,
              `committed[${index}].sha`,
              `no commit ${sha} in the workspace`,
            );
          }
          throw error;
        }
      }),
    );
  }
}
