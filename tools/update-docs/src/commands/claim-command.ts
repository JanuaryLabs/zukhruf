import type { ClaimStore } from '../claims/claim-store.ts';
import { Claim } from '../claims/claim.ts';
import type { ClaimedPaths } from '../claims/claimed-paths.ts';
import { ClaimRefused } from '../errors.ts';
import type { Project } from '../workspace/project.ts';
import type { Workspace } from '../workspace/workspace.ts';
import type { Outcome } from './outcome.ts';

/** The one file outside a project that a project's run may write. */
const CONTEXT_MAP = 'CONTEXT-MAP.md';
// The copy ledgers that copy-check reads: **/docs/copied-*.md.
const COPY_LEDGER = /(?:^|\/)docs\/copied-[^/]*\.md$/;

/**
 * Claims Markdown paths for one run of a project before any writer edits
 * them. A path must be clean, so its content at HEAD is the run's start and
 * `release --revert` can put it back without touching a peer's edit.
 */
export class ClaimCommand {
  readonly #workspace: Workspace;
  readonly #paths: ClaimedPaths;
  readonly #store: ClaimStore;

  constructor(workspace: Workspace, paths: ClaimedPaths, store: ClaimStore) {
    this.#workspace = workspace;
    this.#paths = paths;
    this.#store = store;
  }

  /** `paths` are relative to the workspace, with forward slashes. */
  async run(
    name: string,
    paths: readonly string[],
    now: Temporal.Instant,
  ): Promise<Outcome> {
    const project = await this.#workspace.project(name);
    for (const path of paths) {
      this.#inScope(project, path);
    }
    const [uncommitted] = await this.#paths.uncommitted(paths);
    if (uncommitted !== undefined) {
      throw new ClaimRefused(
        uncommitted,
        'uncommitted',
        'it has uncommitted changes, maybe another session is editing it',
      );
    }
    const claim = new Claim({
      project: project.name,
      paths,
      head: await this.#paths.head(),
      at: now.toString(),
      stamp: { kind: 'none' },
    });
    await this.#store.create(claim);
    // Checked after the exclusive create, so two runs that race for the root
    // CONTEXT-MAP.md both see each other and both refuse, never both hold it.
    const others = (await this.#store.all()).filter(
      (other) => other.project !== project.name,
    );
    for (const other of others) {
      const shared = other.paths.find((path) => paths.includes(path));
      if (shared !== undefined) {
        await this.#store.remove(project.name);
        throw new ClaimRefused(
          shared,
          'claimed',
          `the open claim of ${other.project} holds it`,
        );
      }
    }
    return { exitCode: 0, stdout: '' };
  }

  #inScope(project: Project, path: string): void {
    if (!path.endsWith('.md')) {
      throw new ClaimRefused(path, 'not-markdown', 'it is not a .md file');
    }
    if (COPY_LEDGER.test(path)) {
      throw new ClaimRefused(
        path,
        'copy-ledger',
        'it is a copy ledger, which copy-check owns: edit it by hand and run copy-check',
      );
    }
    if (!path.startsWith(`${project.root}/`) && path !== CONTEXT_MAP) {
      throw new ClaimRefused(
        path,
        'outside-project',
        `it is neither under ${project.root}/ nor the root ${CONTEXT_MAP}`,
      );
    }
  }
}
