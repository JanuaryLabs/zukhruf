import type { Git } from '../git.ts';
import type { Since } from '../since.ts';
import type { Project } from '../workspace/project.ts';
import type { PackageCommitRecord } from './record.ts';

const RECORD = '\u{1e}';
const FIELD = '\u{1f}';
const PATHS_PER_COMMIT = 5;

/**
 * The workspace commits that change a project's code. A commit that changes
 * only Markdown under the root is no evidence: code changes make docs stale,
 * and a run's own docs commits must not start the next run.
 */
export class PackageHistory {
  readonly #git: Git;

  constructor(git: Git) {
    this.#git = git;
  }

  async commits(
    project: Project,
    since: Since,
  ): Promise<PackageCommitRecord[]> {
    const log = await this.#git.run([
      'log',
      ...since.gitArgs(),
      `--format=${RECORD}%H${FIELD}%cI${FIELD}%s`,
      '--name-only',
      '--',
      project.root,
    ]);
    const records: PackageCommitRecord[] = [];
    for (const entry of log.split(RECORD).slice(1)) {
      const [header = '', ...files] = entry.split('\n').filter(Boolean);
      const [sha = '', ts = '', subject = ''] = header.split(FIELD);
      if (files.some((file) => !file.endsWith('.md'))) {
        records.push({
          source: 'package-commit',
          ts,
          ref: sha,
          text: [
            subject,
            ...files.slice(0, PATHS_PER_COMMIT),
            ...(files.length > PATHS_PER_COMMIT
              ? [`and ${files.length - PATHS_PER_COMMIT} more`]
              : []),
          ].join('\n'),
        });
      }
    }
    return records;
  }
}
