import type { ClaudeHome } from '../claude-home.ts';
import type { Git } from '../git.ts';
import { ConsumerRepos } from './consumer-repos.ts';
import { PackageHistory } from './package-history.ts';
import type { EvidenceRecord } from './record.ts';
import type { Watch } from './transcripts.ts';
import { TranscriptArchive } from './transcripts.ts';

/** Every source of evidence, read once for all the watched projects. */
export class Evidence {
  readonly #history: PackageHistory;
  readonly #consumers: ConsumerRepos;
  readonly #transcripts: TranscriptArchive;

  constructor(claude: ClaudeHome, git: Git) {
    this.#history = new PackageHistory(git);
    this.#consumers = new ConsumerRepos(claude, git);
    this.#transcripts = new TranscriptArchive(claude, git.directory);
  }

  /** The records of each watched project, by project name. */
  async collect(
    watches: readonly Watch[],
  ): Promise<Map<string, EvidenceRecord[]>> {
    const [transcripts, repos] = await Promise.all([
      this.#transcripts.scan(watches),
      this.#consumers.discover(),
    ]);
    const npmNames = watches.map(({ project }) => project.npmName);
    const declared = await Promise.all(
      repos.map(async (repo) => ({
        repo,
        names: await repo.declares(npmNames),
      })),
    );
    const collected = new Map<string, EvidenceRecord[]>();
    for (const { project, since } of watches) {
      const consumers = declared
        .filter(({ names }) => names.has(project.npmName))
        .map(({ repo }) => repo);
      const sites = await Promise.all(
        consumers.map((repo) => repo.sites(project)),
      );
      const commits = since.bounded
        ? await Promise.all(
            consumers.map((repo) => repo.commits(project, since)),
          )
        : [];
      collected.set(project.name, [
        ...(await this.#history.commits(project, since)),
        ...sites.flat(),
        ...commits.flat(),
        ...(transcripts.get(project.name) ?? []),
      ]);
    }
    return collected;
  }
}
