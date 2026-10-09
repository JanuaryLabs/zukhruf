/** The holder's view of a lease: act on the subject until `signal` aborts. */
export interface Lease {
  /**
   * Aborts once, with a `LeaseLostError`, when another holder may have the
   * right. It never aborts when the holder releases the lease.
   */
  readonly signal: AbortSignal;
}
