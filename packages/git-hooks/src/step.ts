// What a step gives back to the hook. A fail stops the commit or the push; a
// skip says why the step had nothing to do.
export interface Outcome {
  readonly kind: 'pass' | 'skip' | 'fail';
  readonly message: string;
}

// One check or task of a hook. A subclass names itself and says what it does
// with its subject: the staged commit for a pre-commit step, the push for a
// pre-push step. The hook runs the steps in order and stops at the first fail.
export abstract class Step<Subject> {
  abstract readonly name: string;

  abstract run(subject: Subject): Promise<Outcome>;

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
