/** The failure of a job as data: the name and the message of what the worker threw (ADR 0019). */
export interface Failure {
  readonly name: string;
  readonly message: string;
}

/**
 * The job failed its last run: the worker failed or exited, the kind's time
 * limit ended, or its heartbeat lapsed. Temporal's ApplicationFailure.
 */
export class JobFailedError extends Error {
  readonly failure: Failure;

  constructor(id: string, failure: Failure) {
    super(
      `The job ${id} failed its last run: ${failure.name}: ${failure.message}`,
    );
    this.name = 'JobFailedError';
    this.failure = failure;
  }
}

/** The job was cancelled, by cancel() of a handle or by the abort of a run. Temporal's CancelledFailure. */
export class JobCancelledError extends Error {
  constructor(id: string) {
    super(`The job ${id} was cancelled.`);
    this.name = 'JobCancelledError';
  }
}

/**
 * The store has no job with the id of a handle: the store deleted it after
 * its retention, it belongs to another revision, or it never existed.
 * Temporal's WorkflowNotFoundError.
 */
export class JobNotFoundError extends Error {
  constructor(id: string) {
    super(
      `The store has no job ${id}: it was deleted after its retention, it belongs to another revision of the kind, or it never existed.`,
    );
    this.name = 'JobNotFoundError';
  }
}

/** A wait or a call of a Pool after its disposal. .NET's ObjectDisposedException. */
export class DisposedError extends Error {
  constructor() {
    super('The pool is disposed: it sends and waits no more. Make a new Pool.');
    this.name = 'DisposedError';
  }
}
