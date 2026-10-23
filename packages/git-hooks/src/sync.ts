import { matchesGlob } from 'node:path';

import type { Commit } from './commit.ts';
import { type Outcome, Step } from './step.ts';

// Runs `nx sync`, then stages the files that it wrote. `sync.applyChanges`
// in nx.json applies only in an interactive terminal, so a commit from a GUI
// client or an agent shell would miss the synced files.
//
// A file counts as synced when it changed during the run and matches `stage`:
// the file names that the repo's sync generators write. Any other change
// during the run, or a file that was already modified before it, belongs to
// another session that edits the same working tree.
export class Sync extends Step {
  readonly name = 'sync';
  readonly #globs: readonly string[];

  constructor({
    stage = ['**/tsconfig*.json'],
  }: { stage?: readonly string[] } = {}) {
    super();
    this.#globs = stage;
  }

  async run(commit: Commit): Promise<Outcome> {
    const before = new Set(await commit.modified());
    try {
      await commit.nx('sync');
    } catch (error) {
      // A failed sync is the step's outcome: the author reads nx's reason, not
      // a stack trace of the hook.
      if (!(error instanceof Error)) throw error;
      return this.fail(error.message.trimEnd());
    }
    const synced = (await commit.modified()).filter(
      (path) =>
        !before.has(path) &&
        this.#globs.some((glob) => matchesGlob(path, glob)),
    );
    if (synced.length === 0) return this.pass('nx sync wrote nothing to stage');
    await commit.stage(synced);
    return this.pass(`staged what nx sync wrote: ${synced.join(', ')}`);
  }
}
