# A timeout keeps the process alive only when the caller says so

`timeout(ms, { clock })` had no `ref` option ([ADR 0006](./0006-a-timeout-is-a-signal-on-the-clock-that-the-caller-gives.md)). Its timer kept the process alive until it fired or until the disposal. The timer of `AbortSignal.timeout` does not.

Some waits need the other choice. The hold of a reaper of `@zukhruf/testing` runs an exec with `ref: false`, so the exec keeps no process running. The global setup waited for that hold, and nothing kept its process alive: the global setup ended before the hold had its answer (#4205). Thus a wait whose work keeps no process running needs a timer that does. A second hold, taken while the process lives, must not keep the process alive. Its bound must not keep it alive either. `@zukhruf/testing` built this bound from `delay(ms, { ref })` and two `AbortController`s, because `timeout` had no `ref`.

## Decision

`timeout` takes `ref`:

```ts
export interface TimeoutOptions {
  clock: Clock;
  ref?: boolean | undefined;
}
```

1. Without `ref`, or with `false`, `timeout` calls `unref()` on the timer of each part, when the timer has one. The timeout then does not keep the process alive, as the timer of `AbortSignal.timeout` does not.
2. With `true`, each timer keeps its default, and the process stays alive until the signal aborts or until the disposal.

The leaders split by the shape of the call, not by the tool:

- A signal that aborts after a time keeps no process alive. `AbortSignal.timeout` of Node.js does not: a probe on 2026-11-17 (Node.js 26.13) ended at once with a pending `AbortSignal.timeout(2000)` and its listener. The `AbortSignal.timeout` of Deno has the same contract, and `deadline` of the Deno standard library (`@std/async`) races a promise against it.
- A wait for a time keeps the process alive. `setTimeout` of `node:timers/promises` has `ref`, default `true`. `delay` of `@std/async` has `persistent`, default `true`. `delay` of this package keeps the default of the timer unless `ref` is `false` ([ADR 0005](./0005-a-wait-runs-on-the-clock-that-the-caller-gives.md)).

`timeout` gives a signal, so it takes the default of the signal: no `ref`. The work that the timeout limits, such as a request on a socket, keeps the process alive by itself. A timeout that keeps the process alive past that work holds a script or a command after it is done.

## Considered Options

- **No `ref`, as before.** Each caller whose work keeps no process running builds its own bound from `delay` and controllers.
- **`ref`, default `true`.** It keeps the default of `delay` and of the old `timeout`. It is not the default of `AbortSignal.timeout`, the call that `timeout` replaces in library code (`island/no-ambient-time`).
- **`ref`, default `false`.** This option was selected.

## Consequences

- Breaking: a timeout without `ref` no longer keeps the process alive. A caller whose wait must end at the timeout also when no other work keeps the process alive gives `ref: true`. In this repository: the check of a `ChangeWatcher` (the wait between checks keeps the process alive, so a read that never answers fails at the timeout), `settleWithin` of `@zukhruf/testing` (a promise that never settles fails with its label) and the hold of a reaper of `@zukhruf/testing` that a process waits for.
- The other callers in this repository, and the one in elt (`sitemap-urls.ts` of the Google Search Console SDK), limit a request on a socket or on a child process, so they keep the default.
- `delay` is not changed.
- The tests "a process whose only pending work is a timeout that leaves ref out ends before the signal aborts" and "a process whose only pending work is a timeout with ref true stays alive through each part until the signal aborts" run `timeout` in a child process.
