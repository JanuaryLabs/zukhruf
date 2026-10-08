/** An error as a flight record keeps it: the parts that JSON carries to another process. */
export interface RecordedError {
  readonly name: string;
  readonly message: string;
  readonly code?: string | number;
}

/** Where a flight is: still running, or how it ended. */
export type Status = 'running' | 'succeeded' | 'failed' | 'interrupted';

/** How a flight ended, as its leader records it. */
export type Finished =
  | { readonly status: 'succeeded'; readonly value: unknown }
  | { readonly status: 'failed'; readonly error: RecordedError }
  | { readonly status: 'interrupted' };

/** What a joiner reads about a flight: running, how it ended, or missing when its record is gone. */
export type Outcome =
  | { readonly status: 'running' }
  | { readonly status: 'succeeded'; readonly value: unknown }
  | { readonly status: 'failed'; readonly error: RecordedError }
  | { readonly status: 'interrupted'; readonly successor?: string }
  | { readonly status: 'missing' };

/** The flight that a key began last. */
export interface LatestFlight {
  readonly id: string;
  readonly status: Status;
}

/**
 * Where the outcomes of flights live, so that callers in other processes can
 * join a flight. Only the holder of a key writes the records of the key.
 * Joiners only read them.
 */
export interface FlightRecords {
  /**
   * Records a new running flight of `key` and returns its id. A flight of the
   * key that is still running stopped before it had an outcome: it becomes
   * interrupted, with the new flight as its successor.
   */
  begin(key: string): Promise<string>;
  /** Records how flight `id` ended. Does nothing when the flight is no longer running. */
  finish(key: string, id: string, outcome: Finished): Promise<void>;
  /** The flight that `key` began last, or `undefined` when the key has no record. */
  latest(key: string): Promise<LatestFlight | undefined>;
  /**
   * The outcome of flight `id`. An outcome stays readable for a time after
   * its flight ended, so a joiner that reads it late finds it after newer
   * flights of the key began.
   */
  outcome(key: string, id: string): Promise<Outcome>;
}

/** The parts of a thrown value that a record keeps. A value that is not an error keeps only its text. */
export function recordedError(error: unknown): RecordedError {
  if (!(error instanceof Error))
    return { name: 'Error', message: String(error) };
  const { name, message } = error;
  const code = 'code' in error ? error.code : undefined;
  return typeof code === 'string' || typeof code === 'number'
    ? { name, message, code }
    : { name, message };
}

export const isRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null;

export function isRecordedError(value: unknown): value is RecordedError {
  if (!isRecord(value)) return false;
  const { name, message, code } = value;
  return (
    typeof name === 'string' &&
    typeof message === 'string' &&
    (code === undefined || typeof code === 'string' || typeof code === 'number')
  );
}

export function isOutcome(value: unknown): value is Outcome {
  if (!isRecord(value)) return false;
  switch (value['status']) {
    case 'running':
    case 'missing':
      return true;
    case 'succeeded':
      return 'value' in value;
    case 'failed':
      return isRecordedError(value['error']);
    case 'interrupted':
      return (
        value['successor'] === undefined ||
        typeof value['successor'] === 'string'
      );
    default:
      return false;
  }
}
