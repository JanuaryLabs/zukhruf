import { ClaimOvertaken, NotStamped, StampMismatch } from '../errors.ts';
import type { Claim } from './claim.ts';
import type { ClaimedPaths } from './claimed-paths.ts';
import { readPathState, samePathState } from './path-state.ts';

/**
 * Proves that claimed paths hold what the run left in them: the stamped
 * content on disk, no commit since the claim that changed them, and nothing
 * staged for them in the shared index. Anything else is another session's
 * work, which commit and release must not take or undo.
 */
export class ClaimGuard {
  readonly #repoRoot: string;
  readonly #paths: ClaimedPaths;

  constructor(repoRoot: string, paths: ClaimedPaths) {
    this.#repoRoot = repoRoot;
    this.#paths = paths;
  }

  async asLeft(
    claim: Claim,
    paths: readonly string[],
    command: string,
  ): Promise<void> {
    const { stamp } = claim;
    if (stamp.kind === 'none') {
      throw new NotStamped(claim.project, command);
    }
    const changed: string[] = [];
    for (const path of paths) {
      const stamped = stamp.states.get(path);
      const now = await readPathState(this.#repoRoot, path);
      if (stamped === undefined || !samePathState(stamped, now)) {
        changed.push(path);
      }
    }
    if (changed.length > 0) {
      throw new StampMismatch(changed);
    }
    const committed = await this.#paths.changedBetween(
      claim.head,
      'HEAD',
      paths,
    );
    if (committed.length > 0) {
      throw new ClaimOvertaken(committed, 'A commit changed them');
    }
    const staged = await this.#paths.staged(paths);
    if (staged.length > 0) {
      throw new ClaimOvertaken(staged, 'Another session staged them');
    }
  }
}
