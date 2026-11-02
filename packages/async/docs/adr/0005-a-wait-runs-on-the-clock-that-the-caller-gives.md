# A wait runs on the clock that the caller gives

Status: design for review. The code does not take the clock yet (backlog #3570).

`poll` and `pollChanges` wait between two attempts or two checks. Each wait calls `setTimeout` of `node:timers/promises` itself, and `poll` compares its deadline with the global `performance.now()`. A test can not move this time. A test of the election waits its full campaign. A test of an elt source waits a real one-second check, and then waits 1.5 seconds more to show that no other check found a change.

[Root ADR 0004](../../../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md) decides that a library that waits takes the clock as an input. This ADR applies the decision to this package, the first package in the base layer.

## Decision

`poll` and `pollChanges` take a `clock`. The option is required. This package exports the type of the clock:

```ts
/** The timer source of a wait. Production gives `globalThis`; a test gives a fake clock. */
export interface Clock<Timer extends { unref(): unknown }> {
  setTimeout(callback: () => void, ms: number): Timer;
  clearTimeout(timer: Timer): void;
  performance: { now(): number };
}
```

The type has only the members that this package calls ([mutex ADR 0022](../../../mutex/docs/adr/0022-a-database-lock-store-takes-its-session-from-the-caller.md) does the same for a session). The type of the timer is a parameter: Node.js gives a `Timeout`, and `createClock()` of `@sinonjs/fake-timers` gives its own timer object. Both have `unref()`.

A wait on the clock does these steps:

1. Start a timer with `clock.setTimeout(resolve, interval)`.
2. When `ref` is `false`, call `timer.unref()`. The wait then does not keep the process alive, as before ([ADR 0003](./0003-the-election-and-the-file-lock-stores-poll-through-one-function.md)).
3. Wait through `untilAborted(wait, signal)`, so that a stopped event can not leave the wait pending ([ADR 0001](./0001-a-wait-listens-for-the-abort-through-addabortlistener.md)).
4. When the signal aborts, call `clock.clearTimeout(timer)`. The signal stops the timer, as before. Then `poll` rejects with the reason of the signal, and `pollChanges` ends with no error ([ADR 0004](./0004-a-change-watcher-yields-each-check-with-the-keys-that-changed.md)).

A deadline is a time from `clock.performance.now()`. The caller computes the deadline from the same clock that it gives to `poll`. A deadline from another clock is a defect of the caller, and the type can not find it, because both are numbers.

A caller that has more work on the time, for example `Date.now()` or `setInterval`, declares its own type: `Clock<Timer> & { Date: { now(): number } }`. It adds only the members that it calls.

## Considered Options

- **`Pick<typeof globalThis, 'setTimeout' | 'clearTimeout' | 'performance'>`.** TypeScript refuses `createClock()` for it. The `setTimeout` of Node.js gives a `Timeout` and has a `__promisify__` property. The `clearTimeout` of Node.js accepts a string. The functions of `createClock()` do not match these types, so a test would need an `as`, and the lint refuses `as`.
- **An optional `clock` with `globalThis` as the default.** A caller can forget the clock, and the type check does not tell it ([relevance-filtering ADR 0007](../../../information-filtering/relevance-filtering/docs/adr/0007-a-score-takes-a-signal.md) refuses an optional signal for the same reason). A library that forgets it waits on real time in its tests, with no error.
- **`util.promisify(clock.setTimeout)`.** For Node.js it gives the `setTimeout` of `node:timers/promises`. For `createClock()` it gives a promise that ignores the signal and gives no timer, so the wait can not stop the timer or call `unref()`.
- **A `TestClock` in `@zukhruf/testing`.** The tests of this package can not import `@zukhruf/testing`, because the import makes a cycle in the build ([root ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md)). Also, `createClock()` already does the work.
- **A required `clock` with a structural type that is generic over the timer.** This option was selected.

## Consequences

- Each caller gives the clock. In this workspace there are six calls: the campaign of `@zukhruf/election`, the two waits of the key locks of `@zukhruf/single-flight` (one with `ref: false`), `FileLockStore` of `@zukhruf/mutex` and its three subclasses, `Container.remove` of `@zukhruf/docker`, and the watch of `@zukhruf/sqlite-changefeed`. Each one takes the clock from its own caller, up to the app, which gives `globalThis` (#3570).
- The tests of this package give `createClock()`. They move the time with `await clock.tickAsync(ms)`, and they do not assert elapsed times.
- `@sinonjs/fake-timers` is a dev dependency of this package. The package still has no runtime dependency.
- The wait no longer uses `node:timers/promises`. The `ref` option keeps its meaning, but `poll` calls `unref()` on the timer instead of giving `ref` to Node.js.
