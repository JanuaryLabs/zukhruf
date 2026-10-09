# A wait listens for the abort through `addAbortListener`

A caller cancels a wait with a signal. Before this decision, `untilAborted` listened for the `abort` event with `signal.addEventListener`. An `AbortSignal` is an `EventTarget`, so a listener of the `abort` event can call `event.stopImmediatePropagation()`. Then the listeners that were added after it do not run. A caller often shares its signal with other code. When that code stops the event, the wait stays pending after the abort, and the caller waits forever. A test on Node.js 26.10 showed this. The DOM standard gives this behavior to `addEventListener`, so Node.js cannot change it. Node.js added `events.addAbortListener` for this problem. Its listener runs also on a stopped event, and it returns a `Disposable` that removes the listener. Thus `untilAborted` listens through `addAbortListener`. `addAbortListener` is stable since Node.js 24.0.0 and 22.16.0.

`@zukhruf/mutex` and `@zukhruf/single-flight` each had a copy of `untilAborted`. This correction would have to go into both copies. Thus the function is in this package, and both packages use it.

## Considered Options

- **Keep `addEventListener`.** The wait stays pending after a stopped event.
- **Use a package from npm.** We gave each package the same tests as `untilAborted`. Each one settles correctly when the promise settles first, when the signal aborts first, and when the signal aborted before the call. But none ends the wait after a stopped event:

  | Package              | Function                | Weekly downloads (2026-10) | Wait ends after a stopped event | Listeners after 20 waits on one signal |
  | -------------------- | ----------------------- | -------------------------- | ------------------------------- | -------------------------------------- |
  | `abort-controller-x` | `abortable`             | 2.9 million                | No                              | 0                                      |
  | `race-signal`        | `raceSignal`            | 279,000                    | No                              | 0                                      |
  | `abort-utils`        | `promiseRaceWithSignal` | 6,000                      | No                              | 0                                      |
  | `@solana/promises`   | `getAbortablePromise`   | 3.4 million                | No                              | 20                                     |

  All four listen with `addEventListener`. A dependency would add a package that we must update, and it would bring the defect back.

- **Use only the functions of Node.js.** Node.js has no function that stops a wait for any promise. `Promise.race` with `events.once(signal, 'abort')` leaves one listener on the signal for each wait. `util.aborted(signal, resource)` resolves instead of rejecting, and it removes its listener only after the garbage collector removes the resource. The DOM standard has an open issue for a promise on `AbortSignal` ([whatwg/dom#946](https://github.com/whatwg/dom/issues/946)), since 2021.
- **Write the function on `addAbortListener`, in one package.** Deno's standard library has the same function, `abortable`, in `@std/async`. This option was selected.

## Consequences

- A wait ends when its signal aborts, also after a stopped event.
- `@zukhruf/mutex` and `@zukhruf/single-flight` depend on `@zukhruf/async`.
- `untilAborted` cannot stop the work. A caller that cancels must deal with the work that continues.
