import { RetrieverUnavailableError } from './retriever-unavailable-error.ts';

/**
 * No child of a fusion answered (ADR 0014). It is a RetrieverUnavailableError,
 * so a fusion with no answer is an unavailable child of the fusion above it:
 * an empty list would read as "nothing found". `failures` names each child
 * and its error, and the cause is an AggregateError of them.
 */
export class NoRetrieverAnsweredError extends RetrieverUnavailableError {
  override readonly name = 'NoRetrieverAnsweredError';
  readonly failures: ReadonlyMap<string, RetrieverUnavailableError>;

  constructor(failures: ReadonlyMap<string, RetrieverUnavailableError>) {
    super(`No retriever answered: ${[...failures.keys()].join(', ')}`, {
      cause: new AggregateError([...failures.values()]),
    });
    this.failures = failures;
  }
}
