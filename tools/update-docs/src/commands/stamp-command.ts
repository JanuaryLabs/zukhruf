import type { ClaimStore } from '../claims/claim-store.ts';
import { formatPathState, readPathState } from '../claims/path-state.ts';
import type { Outcome } from './outcome.ts';

/**
 * Records what each claimed path holds once the writers finish, so commit and
 * release can tell the run's drafts from a later edit by another session.
 */
export class StampCommand {
  readonly #repoRoot: string;
  readonly #store: ClaimStore;

  constructor(repoRoot: string, store: ClaimStore) {
    this.#repoRoot = repoRoot;
    this.#store = store;
  }

  async run(project: string, now: Temporal.Instant): Promise<Outcome> {
    const claim = await this.#store.read(project);
    const states = new Map(
      await Promise.all(
        claim.paths.map(
          async (path) =>
            [path, await readPathState(this.#repoRoot, path)] as const,
        ),
      ),
    );
    await this.#store.replace(claim.stamped(now.toString(), states));
    return {
      exitCode: 0,
      stdout: [...states]
        .map(([path, state]) => `${path} ${formatPathState(state)}\n`)
        .join(''),
    };
  }
}
