/** The failure of a job as data: the name and the message of what the worker threw (ADR 0019). */
export interface Failure {
  readonly name: string;
  readonly message: string;
}

/**
 * Makes `instanceof` of a pool error class recognize an error that another
 * copy of the package built (ADR 0027): the class's prototype carries the
 * brand `Symbol.for('@zukhruf/pool/<name>')`, which every copy shares, and the
 * class checks for it. A subclass that declares no `Symbol.hasInstance` of
 * its own inherits this one, so for it the check falls back to the prototype
 * chain; else every instance of the class would be an instance of the
 * subclass. Temporal's SymbolBasedInstanceOfError.
 */
export function brand(
  errorClass: abstract new (...args: never[]) => Error,
  name: string,
): void {
  const marker = Symbol.for(`@zukhruf/pool/${name}`);
  Object.defineProperty(errorClass.prototype, marker, { value: true });
  Object.defineProperty(errorClass, Symbol.hasInstance, {
    value(this: typeof errorClass, value: unknown): boolean {
      if (typeof value !== 'object' || value === null) return false;
      if (this === errorClass) return Reflect.get(value, marker) === true;
      return Object.prototype.isPrototypeOf.call(this.prototype, value);
    },
  });
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
brand(JobFailedError, 'JobFailedError');

/** The job was cancelled, by cancel() of a handle or by the abort of a run. Temporal's CancelledFailure. */
export class JobCancelledError extends Error {
  constructor(id: string) {
    super(`The job ${id} was cancelled.`);
    this.name = 'JobCancelledError';
  }
}
brand(JobCancelledError, 'JobCancelledError');

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
brand(JobNotFoundError, 'JobNotFoundError');

/**
 * The store holds a newer revision of the kind, so this host's revision is
 * deprecated: it sends no job and owns no workers (ADR 0022). Amazon SWF's
 * ACTIVITY_TYPE_DEPRECATED.
 */
export class DeprecatedRevisionError extends Error {
  /** The name of the kind. */
  readonly kind: string;
  /** The revision of this host. */
  readonly revision: number;
  /** The newest revision of the kind in the store. */
  readonly newest: number;

  constructor(options: { kind: string; revision: number; newest: number }) {
    super(
      `Revision ${options.revision} of the kind ${options.kind} is deprecated: the store holds revision ${options.newest}. Update the host.`,
    );
    this.name = 'DeprecatedRevisionError';
    this.kind = options.kind;
    this.revision = options.revision;
    this.newest = options.newest;
  }
}
brand(DeprecatedRevisionError, 'DeprecatedRevisionError');

/** A wait or a call of a Pool after its disposal. .NET's ObjectDisposedException. */
export class DisposedError extends Error {
  constructor() {
    super('The pool is disposed: it sends and waits no more. Make a new Pool.');
    this.name = 'DisposedError';
  }
}
brand(DisposedError, 'DisposedError');
