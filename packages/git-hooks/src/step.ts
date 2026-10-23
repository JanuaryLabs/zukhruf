import type { Commit } from './commit.ts';

// What a step gives back to the hook. A fail stops the commit; a skip says why
// the step had nothing to do.
export interface Outcome {
  readonly kind: 'pass' | 'skip' | 'fail';
  readonly message: string;
}

// One check or task of a hook. A subclass names itself and says what it does
// with the staged commit; the hook runs the steps in order and stops the
// commit at the first fail.
export abstract class Step {
  abstract readonly name: string;

  abstract run(commit: Commit): Promise<Outcome>;

  protected pass(message = ''): Outcome {
    return { kind: 'pass', message };
  }

  protected skip(message: string): Outcome {
    return { kind: 'skip', message };
  }

  protected fail(message: string): Outcome {
    return { kind: 'fail', message };
  }
}
