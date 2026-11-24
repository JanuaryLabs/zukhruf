# At the timeout of a check, a read that rejects within one turn of the event loop fails with its own error

Status: Accepted 2026-11-24 (backlog #5566).

Decision-makers: Ezz chose option A on 2026-11-24 in the elt session elt-7c: at the timeout, when the read rejects within a short time after the abort, the outcome has the error of the read, else the reason of the signal. The agent that built #5566 chose one turn of the event loop as that time, from the evidence below.

A change watcher gives each read `check.signal`, which aborts when the check passes its `timeout` ([ADR 0008](./0008-a-change-watcher-reads-gauges.md)). The watcher waited for each read through `untilAborted`, which rejects with `signal.reason` at the abort. That reason is the `DOMException` of `timeout`, "The operation was aborted due to timeout", whose name is `TimeoutError` ([ADR 0006](./0006-a-timeout-is-a-signal-on-the-clock-that-the-caller-gives.md)). A read that stops at the abort rejects a moment later, and its error can tell what the read was doing, for example `Error('timed out in open after 200 ms', { cause: reason })`. The watcher dropped that error. This is error masking: the error of the deadline hides the error of the work.

datahub #5380 found it. The change checks of the Central connection on Azure SQL time out in bursts, and elt records only "The operation was aborted due to timeout" for each watched stream, so nobody can tell which step of the check took the time. A probe on `@zukhruf/async` 0.8.100 gave a gauge that listens for the abort and rejects at once with its own error. The outcome was still the `TimeoutError`.

The leading clients keep the step in the error of a timeout:

- Go `net/http` waits for the transport to return its error after the deadline, and adds the step: "context deadline exceeded (Client.Timeout exceeded while awaiting headers)" (`src/net/http/client.go:732` of Go 1.24.0), and "(Client.Timeout or context cancellation while reading body)" (`:979`).
- undici gives one error for each step: `ConnectTimeoutError`, `HeadersTimeoutError` and `BodyTimeoutError` (`lib/core/errors.js:21`, `:39`, `:75` of undici 7.30.1).

## Decision

At the abort of `check.signal`, the watcher waits one turn of the event loop for the read. A read that rejects in that turn fails with its own error. A read that does not reject in that turn fails with `signal.reason`.

- A read that names its step rejects with an error that has the reason as its `cause`. The consumer then gets the step and the `TimeoutError` in one error.
- A read that rejects with `signal.reason` fails with that same object, as before.
- A read that never answers, also one that ignores the signal, fails with `signal.reason` one turn of the event loop after the abort. One slow read thus still does not hold up the check.
- A read that gives a value in that turn fails with `signal.reason`. The read took longer than `timeout`, and ADR 0008 says that such a read fails for that check.
- A read that rejects before the abort fails with its own error at once, as before.
- The turn is `setImmediate` of `node:timers/promises`. The rejections of the abort listeners and of the promise chains after them run as microtasks, so they all come before the next turn. The I/O callbacks that are ready at the abort also run in that turn, before the check phase of the event loop. A turn is not a time, so it is not on the clock of the watch ([ADR 0005](./0005-a-wait-runs-on-the-clock-that-the-caller-gives.md)): the rule `island/no-ambient-time` of `@zukhruf/eslint` lets a library call `setImmediate` for this reason.

## Considered Options

- **The `TimeoutError` only, as before.** The consumer cannot tell what the read was doing (#5380).
- **Wait for the read without a bound after the abort.** A read that ignores the signal then holds up its check forever. ADR 0008 says that the watcher stops waiting for such a read.
- **A grace of some milliseconds on the clock of the watch.** No evidence gives a number. A read that stops at the abort rejects in microtasks, not in milliseconds. Each test on a fake clock must also move the clock past the grace.
- **Wrap the reason in an error of the watcher, for example `CheckTimeoutError`.** The watcher does not know the step of the read. Only the read knows it, so the read names it.
- **One turn of the event loop.** This option was selected.

## Consequences

- The type `Outcome` does not change: `error` is `unknown`. No consumer of `ChangeWatcher` reads the name of the error: elt records its message (`packages/elt/src/core/pipeline.ts:411`), and `@zukhruf/sqlite-changefeed` and context-compiler throw it. The change is not breaking.
- A gauge that names its step must reject at the abort. elt's SQL Server source is to reject with an error that names its step (open, the validation of the pool, each query of a gauge) and its time, with the reason as its cause (elt follow-up of #5566).
- At an abort of the watch, a read that runs ends one turn of the event loop later. The watch still ends with no error and gives no outcome of that check.

## Confirmation

The tests are in `src/change-watcher.test.ts`:

- "a read that rejects with its own error right after the timeout aborts it fails with that error, so the consumer sees what the read was doing". It was red before the change: the outcome had "The operation was aborted due to timeout".
- "a read that passes the timeout fails at the timeout, also when it never answers and ignores the signal, and the other gauges are not held up", from before the change.
- "a read that gives a value right after the timeout aborts it fails with the TimeoutError, because it took longer than the timeout".
- "a read that rejects with the reason of the abort fails with that same TimeoutError". It was green before the change, and stays green.

Mutations of `untilRead` in `src/change-watcher.ts`, each kept in the memory of the test process, failed their test:

- Without the wait for the read in the race, the outcome had "The operation was aborted due to timeout" in place of "timed out in open".
- With a wait for the read and no bound of one turn, the test of the read that never answers timed out after 10 s.
- With a copy of the reason in place of the reason, the outcome did not have the reason itself.
- With another error, or with the value, for a read that gives a value after the abort, the outcome was not the `TimeoutError`.
