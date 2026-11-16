import type { Commit } from './commit.ts';
import { type Outcome, Step } from './step.ts';

interface CodegenOptions {
  // The nx projects whose change can change the generated files. Without it,
  // the step builds on every commit.
  readonly when?: readonly string[];
  // The nx targets that write the generated files, in order.
  readonly run: readonly string[];
  // Globs of the generated files, which the step stages after the build.
  readonly stage: readonly string[];
}

// Builds generated files, such as an OpenAPI spec and the client made from it,
// from the staged commit, and stages them. With `when`, it builds only when nx
// says that one of those projects is affected by the staged changes: a
// hand-kept list of inputs would miss a file, and an edit that is not staged
// is not part of the commit.
export class Codegen extends Step<Commit> {
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
      const affected = new Set(await affectedProjects(commit));
      if (!this.#when.some((project) => affected.has(project)))
        return this.skip(`none of ${this.#when.join(', ')} is affected`);
    }
    let generated;
    try {
      generated = await commit.generate(this.#stage, async (snapshot) => {
        for (const target of this.#run) {
          const { status, stdout, stderr } = await snapshot.bin('nx', [
            'run',
            target,
          ]);
          if (status !== 0)
            throw new Error(
              `nx run ${target} exited with ${status}:\n${`${stdout}${stderr}`.trimEnd()}`,
            );
        }
      });
    } catch (error) {
      // A failed build is the step's outcome: the author reads the reason that
      // the target gave, not a stack trace of the hook.
      if (!Error.isError(error)) throw error;
      return this.fail(error.message.trimEnd());
    }
    if (generated.kind === 'not-staged') return this.fail(generated.reason);
    return this.pass(
      `ran ${this.#run.join(', ')}; staged ${generated.entries.length === 0 ? 'nothing new' : generated.entries.map(({ path }) => path).join(', ')}`,
    );
  }
}

// The nx projects that the staged changes affect, as nx in the snapshot of
// the staged commit lists them.
async function affectedProjects(commit: Commit): Promise<string[]> {
  const changes = await commit.changes();
  if (changes.length === 0) return [];
  const snapshot = await commit.snapshot({ packages: true });
  const { status, stdout, stderr } = await snapshot.bin('nx', [
    'show',
    'projects',
    '--affected',
    `--files=${changes.map(({ path }) => path).join(',')}`,
    '--json',
  ]);
  if (status !== 0)
    throw new Error(
      `nx show projects exited with ${status}:\n${stderr.trimEnd()}`,
    );
  const projects: unknown = JSON.parse(stdout);
  if (
    !Array.isArray(projects) ||
    !projects.every((project): project is string => typeof project === 'string')
  )
    throw new TypeError(
      `nx show projects gave ${stdout.trim()}, not a list of names`,
    );
  return projects;
}
