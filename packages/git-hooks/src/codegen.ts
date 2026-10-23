import type { Commit } from './commit.ts';
import { type Outcome, Step } from './step.ts';

interface CodegenOptions {
  // The nx projects whose change can change the generated files. Without it,
  // the step builds on every commit.
  readonly when?: readonly string[];
  // The nx targets that write the generated files, in order.
  readonly run: readonly string[];
  // The generated files and folders, which the step stages after the build.
  readonly stage: readonly string[];
}

// Builds generated files, such as an OpenAPI spec and the client made from it,
// and stages them. With `when`, it builds only when nx says that one of those
// projects is affected by the staged files: a hand-kept list of inputs would
// miss a file, and an edit that is not staged is not part of the commit.
export class Codegen extends Step {
  readonly name = 'codegen';
  readonly #when: readonly string[] | undefined;
  readonly #run: readonly string[];
  readonly #stage: readonly string[];

  constructor({ when, run, stage }: CodegenOptions) {
    super();
    this.#when = when;
    this.#run = run;
    this.#stage = stage;
  }

  async run(commit: Commit): Promise<Outcome> {
    if (this.#when !== undefined) {
      const affected = new Set(await commit.affected());
      if (!this.#when.some((project) => affected.has(project)))
        return this.skip(`none of ${this.#when.join(', ')} is affected`);
    }
    try {
      for (const target of this.#run) await commit.nx('run', target);
    } catch (error) {
      // A failed build is the step's outcome: the author reads the reason that
      // the target gave, not a stack trace of the hook.
      if (!(error instanceof Error)) throw error;
      return this.fail(error.message.trimEnd());
    }
    await commit.stage(this.#stage);
    return this.pass(
      `ran ${this.#run.join(', ')}; staged ${this.#stage.join(', ')}`,
    );
  }
}
