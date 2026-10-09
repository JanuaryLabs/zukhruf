import type { Failure } from './protocol/flight-protocol.ts';

/** The work of the flight that this caller joined failed. `failure` describes the error that its leader got. */
export class FlightFailedError extends Error {
  readonly key: string;
  readonly failure: Failure;

  constructor(key: string, failure: Failure) {
    super(
      `The flight of ${JSON.stringify(key)} failed: ${failure.name}: ${failure.message}`,
    );
    this.name = 'FlightFailedError';
    this.key = key;
    this.failure = failure;
  }
}

/**
 * The flight that this caller joined ended without an outcome: its leader's
 * process stopped, or its leader lost the flight. The work is never run again
 * for this caller; a new call starts a new flight.
 */
export class FlightInterruptedError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `The flight of ${JSON.stringify(key)} that this caller joined stopped before it had an outcome.`,
    );
    this.name = 'FlightInterruptedError';
    this.key = key;
  }
}

/** The parts of a thrown value that cross to the joiners. A value that is not an error keeps only its text. */
export function failureOf(error: unknown): Failure {
  if (!(error instanceof Error)) {
    return { name: 'Error', message: String(error) };
  }
  const { name, message } = error;
  const code = 'code' in error ? error.code : undefined;
  return typeof code === 'string' || typeof code === 'number'
    ? { name, message, code }
    : { name, message };
}
