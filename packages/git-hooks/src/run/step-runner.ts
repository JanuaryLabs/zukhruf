import type { Outcome, Step } from '../step.ts';

// What each runner gets from the host, or from a test.
export interface HookRun {
  // The top of the working tree: the folder where git runs the hook.
  readonly root: string;
  // The environment that git gave the hook, for the git commands on the repo.
  readonly hookEnvironment: NodeJS.ProcessEnv;
  // Prints a message under the name of a step.
  readonly print: (name: string, message: string) => void;
}

// What the steps of a hook gave: the outcome of each step that ran, in
// order. When a step failed, its outcome is the last one.
export interface StepsResult {
  readonly kind: 'passed' | 'failed';
  readonly outcomes: readonly Outcome[];
}

// Runs the steps of a hook on one subject in order, and stops at the first
// fail. It prints the outcome of each step under the name of the step. A
// notice that the subject or its snapshots give while a step runs is printed
// under the name of that step too.
export class StepRunner {
  readonly #print: (name: string, message: string) => void;
  #current = '';

  constructor(print: (name: string, message: string) => void) {
    this.#print = print;
  }

  readonly notice = (message: string): void => {
    this.#print(this.#current, message);
  };

  async run<Subject>(
    subject: Subject,
    steps: readonly Step<Subject>[],
  ): Promise<StepsResult> {
    const outcomes: Outcome[] = [];
    for (const step of steps) {
      this.#current = step.name;
      const outcome = await step.run(subject);
      outcomes.push(outcome);
      this.#print(step.name, outcome.message);
      if (outcome.kind === 'fail') return { kind: 'failed', outcomes };
    }
    return { kind: 'passed', outcomes };
  }
}
