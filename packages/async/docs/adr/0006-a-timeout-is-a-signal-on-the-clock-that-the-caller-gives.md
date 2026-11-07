# A timeout is a signal on the clock that the caller gives

Superseded in part on 2026-11-07 (#3922) for the timer. `timeout` now runs its time on `delay`, and the disposal aborts that delay, so a timeout can be longer than one timer can hold ([ADR 0009](./0009-a-wait-longer-than-one-timer-runs-on-a-chain-of-timers.md)). The signal aborts one microtask after the timer fires. The rest of the decision below stays true.

`AbortSignal.timeout(ms)` of Node.js gives a signal that aborts after `ms` milliseconds on the real clock. A test can not move this time. In this workspace, four waits of `@zukhruf/mutex` use it:

- `skipIfBusy({ waitAtMost })` gives up on a busy key after `waitAtMost`. Its test asserts that the wait took 90 ms or more of real time.
- `DockerEngineStore` stops a check of a claim, and the inspect of each heartbeat, after `heartbeatInterval`.
- The heartbeat of `SessionLockStore` stops a late answer of the server after `heartbeatInterval`.

`@zukhruf/testing` has five more, and `@zukhruf/mteb` and elt have more. [Root ADR 0004](../../../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md) decides that a library that waits takes the clock as an input. Thus each of these waits needs a signal that aborts on the clock. That is more than three places, so the Rule of Three of [root ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md) gives the knowledge one home. This package already has `delay` for the same reason ([ADR 0005](./0005-a-wait-runs-on-the-clock-that-the-caller-gives.md)).

## Decision

This package exports `timeout(ms, { clock })`:

```ts
export interface Timeout extends Disposable {
  /** Aborts after the time, with a `DOMException` whose name is `TimeoutError`. */
  readonly signal: AbortSignal;
}
```

1. `timeout` makes an `AbortController`.
2. It starts a timer with `clock.setTimeout`. When the timer fires, the controller aborts with `new DOMException('The operation was aborted due to timeout', 'TimeoutError')`. Node.js 26 gives this reason to the signal of `AbortSignal.timeout`, so a caller that compares the name of the reason works with both signals.
3. A disposal calls `clock.clearTimeout(timer)`. The signal then does not abort.

The timeout is `Disposable`, because a fake clock keeps each timer until the timer fires. A timer that no code stops changes `clock.countTimers()`, and a test reads `countTimers()` to know that the code waits on the clock again. On the real clock, the timer would keep the process alive until it fires. A caller writes `using limit = timeout(ms, { clock })`, and the timer stops at the end of the block. The `Timeout` of Node.js has the same disposal: `using timer = setTimeout(...)` stops the timer at the end of the block. `settleWithin` of `@zukhruf/testing` uses it.

`timeout` has no `ref` option. Each caller disposes the timeout when its wait ends, so the timer does not live longer than the wait.

## Considered Options

- **`AbortSignal.timeout`.** It runs only on the real clock, so a test of `waitAtMost` waits the full time and asserts an elapsed time.
- **An `AbortController` and `clock.setTimeout` at each wait.** Each place keeps the same five lines, with the stop of the timer. A correction would have to go into each copy.
- **A function that gives only the signal.** No call can stop the timer. On a fake clock, `countTimers()` then counts timers of waits that ended.
- **`deadline(promise, ms)` of the Deno standard library (`@std/async`).** It races a promise. The waits of `@zukhruf/mutex` give a signal to the lock store, so that the store stops its own wait. A race ends the wait of the caller, but the store waits on.
- **A disposable `timeout` with a signal.** This option was selected.

## Consequences

- The four waits of `@zukhruf/mutex` use `timeout`, with the clock of their store or mode (#3571). The test of `waitAtMost` then moves the clock to the limit, and asserts no elapsed time.
- The rule `island/no-ambient-time` of `@zukhruf/eslint` reports `AbortSignal.timeout` in library code (#3571). A wait that must run on the real clock gives `globalThis` as the clock: `timeout(ms, { clock: globalThis })`.
- The timer of a timeout keeps the process alive until the disposal. The timer of `AbortSignal.timeout` does not.
