export interface WaitOptions {
  /** Cancels the wait: the wait rejects with `signal.reason`. */
  signal: AbortSignal | undefined;
}
