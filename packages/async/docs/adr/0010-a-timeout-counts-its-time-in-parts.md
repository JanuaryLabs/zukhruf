# A timeout counts its time in parts

A timeout limits the time that a piece of work can take. `timeout` gave its time to one timer, through `delay` ([ADR 0009](./0009-a-wait-longer-than-one-timer-runs-on-a-chain-of-timers.md)). On macOS, a timer of Node.js counts the time of a system sleep: libuv reads `mach_continuous_time()` for its timers there ([`uv__hrtime` in `src/unix/darwin.c`](https://github.com/libuv/libuv/blob/v1.x/src/unix/darwin.c)), a clock that runs while the computer sleeps. On Linux, the same timer reads `CLOCK_MONOTONIC` ([`src/unix/linux.c`](https://github.com/libuv/libuv/blob/v1.x/src/unix/linux.c)), which stops during a suspend. A probe on 2026-11-13 (Node.js 26.13, libuv 1.52.1, macOS 27.2) read `process.hrtime` equal to the wall time since the start of the computer, across 631 sleeps.

Thus a timer that was running when a Mac slept fires at the wake. A `ChangeWatcher` with a `timeout` of 1 second read its gauges in a few milliseconds. When the computer slept during a read, the timeout fired at the wake, before the event loop gave the result of the read, and the check failed with a `TimeoutError`. A watch of elt on a Mac with the lid closed recorded such a failure for nine connections in one night (context-compiler #4293). The work did not take long. The process did not run.

The same occurs when the system stops the process (`SIGSTOP`), and when synchronous work blocks the event loop for longer than the timeout.

## Decision

`timeout` counts its time in ten parts. Each part is one timer of `ceil(ms / 10)` milliseconds, at least 1 ms and at most 2^31-1 ms, and the last part is the remainder. When the timer of a part fires, the next part starts. When the last part fires, the signal aborts.

A part that ends late uses up only its own length. After a sleep, the timer of the part that was running fires one time, and the timeout continues with the parts that are left. A sleep thus takes at most one part, a tenth of the time, from the work that the timeout limits.

`timeout` starts each next timer in the callback of the last one, with no promise between them. Thus a fake clock that moves in one step (`clock.tick(ms)`) fires all parts, as it fired the one timer before, and the signal aborts in the callback of the last timer.

A timeout longer than ten timers of 2^31-1 ms has more than ten parts, so it still lasts the full time. `timeout` no longer runs on `delay`.

## Considered Options

- **One timer, as before.** A sleep of any length ends each timeout that was running.
- **Read a clock that stops during a sleep.** Node.js gives none on macOS: `performance.now()`, `process.hrtime` and the timers read the same clock.
- **One more timer after a late one.** When the timer fires much later than it was set for, wait again. The code must guess how much of the time the work had before the sleep, and how late is late.
- **Parts on `delay`, with a promise between them.** `clock.tick(ms)` of a fake clock then fires only the first part, and each test that moves the clock in one step must change.
- **Parts on timers that start in the callback.** This option was selected.

## Consequences

- A timeout no longer limits the time on the wall clock. It limits the time in which its timers could fire. A wait behind a timeout can thus last a sleep longer than its `ms`.
- A timeout of less than 20 ms has parts of 1 ms, and on the real clock each timer of Node.js lasts 1 ms or more, so such a timeout can last some milliseconds longer than `ms`. On a fake clock it lasts exactly `ms`.
- A timeout of one part, which is each timeout of 1 ms or less, still aborts at the wake.
- `delay` is not changed: a `delay` of 10 minutes that slept for 9 still ends 10 minutes after its start.
- The test "a timer that fires late, as after the computer slept, uses up only its own part of the timeout" moves a fake clock with `clock.jump()`, which fires each due timer one time, as a process that the system stopped.
