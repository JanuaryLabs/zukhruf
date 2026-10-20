export interface CancelOptions {
  /** Cancels the wait for the engine. */
  signal?: AbortSignal;
}

/** The filters of a list or of the events, as the Engine API takes them. */
export type Filters = Record<string, string[]>;
