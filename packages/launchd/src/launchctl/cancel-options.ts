export interface CancelOptions {
  /** Cancels the wait. The call then rejects with `signal.reason`. */
  signal?: AbortSignal;
}
