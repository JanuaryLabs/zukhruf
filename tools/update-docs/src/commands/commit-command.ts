import type { ClaimGuard } from '../claims/claim-guard.ts';
import type { ClaimStore } from '../claims/claim-store.ts';
import type { ClaimedPaths } from '../claims/claimed-paths.ts';
import type { PathCommit } from '../claims/path-commit.ts';
import {
  CommitNotAsClaimed,
  NothingToCommit,
  SubjectRefused,
} from '../errors.ts';
import type { Workspace } from '../workspace/workspace.ts';
import type { Outcome } from './outcome.ts';

/**
 * Commits the claimed paths a run changed, as `docs(<project>): <text>`, and
 * clears the claim. It commits only what the stamp proves is the run's own.
 */
export class CommitCommand {
  readonly #workspace: Workspace;
  readonly #store: ClaimStore;
  readonly #guard: ClaimGuard;
  readonly #paths: ClaimedPaths;
  readonly #committer: PathCommit;

  constructor(parts: {
    workspace: Workspace;
    store: ClaimStore;
    guard: ClaimGuard;
    paths: ClaimedPaths;
    committer: PathCommit;
  }) {
    this.#workspace = parts.workspace;
    this.#store = parts.store;
    this.#guard = parts.guard;
    this.#paths = parts.paths;
    this.#committer = parts.committer;
  }

  /** `body` holds the commit's paragraphs after the subject, if any. */
  async run(
    name: string,
    text: string,
    body: readonly string[],
  ): Promise<Outcome> {
    const subject = this.#subject(text);
    const project = await this.#workspace.project(name);
    const claim = await this.#store.read(project.name);
    await this.#guard.asLeft(claim, claim.paths, 'commit');
    // The shared index holds none of the paths staged (the guard proved it),
    // so what status lists differs from HEAD in the working tree.
    const changed = await this.#paths.uncommitted(claim.paths);
    if (changed.length === 0) {
      throw new NothingToCommit(project.name);
    }
    const sha = await this.#committer.commit(changed, [
      `docs(${project.name}): ${subject}`,
      ...body,
    ]);
    await this.#store.remove(project.name);
    await this.#landedAsClaimed(sha, changed);
    return { exitCode: 0, stdout: `${sha}\n` };
  }

  #subject(text: string): string {
    if (text.trim() === '') {
      throw new SubjectRefused(text, 'is empty');
    }
    if (text.includes('\n')) {
      throw new SubjectRefused(text, 'spans lines: put the rest in --body');
    }
    // The commit-msg hook reads the scope up to the last "): ", so a later
    // one would make it read a scope that names no project.
    if (text.includes('): ')) {
      throw new SubjectRefused(
        text,
        'holds "): ", which the commit-msg hook refuses: write "(#3840); "',
      );
    }
    return text;
  }

  /**
   * A hook can stage more into the commit, such as the pre-commit Sync step
   * staging a tsconfig, so the commit may hold more than the claim changed.
   */
  async #landedAsClaimed(
    sha: string,
    changed: readonly string[],
  ): Promise<void> {
    const files = await this.#paths.changedBy(sha);
    const extra = files.filter((file) => !changed.includes(file));
    const missing = changed.filter((file) => !files.includes(file));
    if (extra.length > 0 || missing.length > 0) {
      throw new CommitNotAsClaimed(
        sha,
        `it holds ${files.join(', ')} where the claim changed ${changed.join(', ')}`,
      );
    }
  }
}
