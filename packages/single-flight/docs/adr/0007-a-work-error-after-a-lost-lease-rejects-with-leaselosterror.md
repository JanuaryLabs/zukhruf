# A work error after a lost lease rejects with LeaseLostError

A leader can lose the lease of its flight while its work runs, for example when its process is frozen past the grace window of a new coordinator. The signal of the lease then aborts with `LeaseLostError`, and the coordinator tells the joiners that the flight is interrupted. Before this decision, the call of the leader rejected with `LeaseLostError` only when the work returned a value after the loss. When the work threw its own error after the loss, the call rejected with that error. Thus a caller that caught a plain error could not know that its work did not run alone. The mutex has the same case, and its [ADR 0013](../../../mutex/docs/adr/0013-a-lost-lease-aborts-the-signal-of-the-lease.md) gives the rule. This package now uses that rule. When the work ends after the signal of its lease aborted:

- If the work returned a value, or threw the reason of the signal, the call rejects with the reason of the signal.
- If the work threw a different error, the call rejects with a new `LeaseLostError`. Its `subject` is the key, and its `cause` is the error of the work.

Thus `instanceof LeaseLostError` has one meaning in the mutex and in the single flight: the caller did not have the right alone while its work ran.

## Considered Options

- **The call rejects with the error of the work.** This was the behavior before. A caller must then read the signal of the lease to know about the loss, and the work does not give that signal to the caller.
- **The call rejects with the reason of the signal, and the error of the work is gone.** The caller knows about the loss, but it cannot see why the work failed.
- **The call rejects with a new `LeaseLostError`, and the error of the work is its `cause`.** The mutex does this ([ADR 0013](../../../mutex/docs/adr/0013-a-lost-lease-aborts-the-signal-of-the-lease.md)). This option was selected.

## Consequences

- A caller that catches `LeaseLostError` handles each loss in one place, for the mutex and for the single flight.
- The error of the work is still available as the `cause`.
- The joiners do not change. When the leader lost the lease, the coordinator interrupted the flight, so each joiner rejects with `FlightInterruptedError`. The leader's landing after the loss reaches nobody.
- A codec that cannot encode the value after a loss gives `LeaseLostError` too, with the error of the codec as its `cause`.
