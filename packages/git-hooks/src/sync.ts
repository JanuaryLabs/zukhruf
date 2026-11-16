import type { Commit } from './commit.ts';
import { type Outcome, Step } from './step.ts';

// Runs `nx sync` on the staged commit, then stages the files that it wrote
// there and that match `stage`: the file names that the repo's sync
// generators write. `sync.applyChanges` in nx.json applies only in an
// interactive terminal, so a commit from a GUI client or an agent shell would
// miss the synced files. nx syncs the staged tree, not the working tree, so a
// file that another session edits is judged as the commit holds it.
export class Sync extends Step<Commit> {
  readonly name = 'sync';
  readonly #globs: readonly string[];

  constructor({
    stage = ['**/tsconfig*.json'],
  }: { stage?: readonly string[] } = {}) {
    super();
    this.#globs = stage;
  }

  async run(commit: Commit): Promise<Outcome> {
    let generated;
    try {
      generated = await commit.generate(this.#globs, async (snapshot) => {
        const { status, stdout, stderr } = await snapshot.bin('nx', ['sync']);
        if (status !== 0)
          throw new Error(
            `nx sync exited with ${status}:\n${`${stdout}${stderr}`.trimEnd()}`,
          );
      });
    } catch (error) {
      // A failed sync is the step's outcome: the author reads nx's reason, not
      // a stack trace of the hook.
      if (!Error.isError(error)) throw error;
      return this.fail(error.message.trimEnd());
    }
    if (generated.kind === 'not-staged') return this.fail(generated.reason);
    if (generated.entries.length === 0)
      return this.pass('nx sync wrote nothing to stage');
    return this.pass(
      `staged what nx sync wrote: ${generated.entries.map(({ path }) => path).join(', ')}`,
    );
  }
}
