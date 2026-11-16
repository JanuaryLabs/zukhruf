import type { ClaimGuard } from '../claims/claim-guard.ts';
import type { ClaimStore } from '../claims/claim-store.ts';
import type { ClaimedPaths } from '../claims/claimed-paths.ts';
import { NotClaimed } from '../errors.ts';
import type { Outcome } from './outcome.ts';

/**
 * `drop` gives paths back without committing; `revert` first puts each back
 * as it was at the claim, which undoes a rejected draft. A revert needs the
 * stamp to prove each path still holds the draft, not a peer's edit.
 */
export type Release = 'drop' | 'revert';

export class ReleaseCommand {
  readonly #store: ClaimStore;
  readonly #guard: ClaimGuard;
  readonly #paths: ClaimedPaths;

  constructor(store: ClaimStore, guard: ClaimGuard, paths: ClaimedPaths) {
    this.#store = store;
    this.#guard = guard;
    this.#paths = paths;
  }

  /** No paths given releases every claimed path. */
  async run(
    project: string,
    release: Release,
    given: readonly string[],
  ): Promise<Outcome> {
    const claim = await this.#store.read(project);
    const paths = given.length === 0 ? claim.paths : given;
    const unknown = paths.filter((path) => !claim.paths.includes(path));
    if (unknown.length > 0) {
      throw new NotClaimed(project, unknown);
    }
    if (release === 'revert') {
      await this.#guard.asLeft(claim, paths, 'release --revert');
      for (const path of paths) {
        await this.#paths.restore(claim.head, path);
      }
    }
    const rest = claim.without(paths);
    await (rest === 'empty'
      ? this.#store.remove(project)
      : this.#store.replace(rest));
    return { exitCode: 0, stdout: '' };
  }
}
