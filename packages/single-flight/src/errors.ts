import type { RecordedError } from './flight-records.ts';

/** The flight that this caller joined in another process failed. `failure` is the error that its leader recorded. */
export class FlightFailedError extends Error {
  readonly key: string;
  readonly failure: RecordedError;

  constructor(key: string, failure: RecordedError) {
    super(
      `The flight of ${JSON.stringify(key)} failed: ${failure.name}: ${failure.message}`,
    );
    this.name = 'FlightFailedError';
    this.key = key;
    this.failure = failure;
  }
}

/**
 * The holder of the flight that this caller joined stopped before the flight
 * had an outcome: its process stopped, its lease was lost, or its records
 * refused the outcome.
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

/** The record of the flight that this caller joined was gone before the caller read its outcome. */
export class FlightOutcomeLostError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `The record of the flight of ${JSON.stringify(key)} that this caller joined was gone before the caller read its outcome.`,
    );
    this.name = 'FlightOutcomeLostError';
    this.key = key;
  }
}
