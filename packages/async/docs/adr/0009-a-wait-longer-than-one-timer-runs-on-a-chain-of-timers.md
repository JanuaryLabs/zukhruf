# A wait longer than one timer runs on a chain of timers

A timer of Node.js holds a delay of at most 2^31-1 ms, about 24.8 days. With a longer delay, Node.js fires the timer after 1 ms and writes a `TimeoutOverflowWarning`. `createClock()` of `@sinonjs/fake-timers` does the same. `delay` gave its `ms` to one `clock.setTimeout`, and `milliseconds()` accepts each positive, finite number. Thus a `ChangeWatcher` with an interval of 30 days did its checks in a tight loop, and a `timeout` of 30 days aborted at once (#3922). elt's Search Console source cut its poll interval to 2^31-1 ms to prevent this.

## Decision

`delay` waits on a chain of timers. Each timer holds at most 2^31-1 ms. When one timer fires, the next timer starts, until the full time has passed. The next timer gets the time that is left on `clock.performance.now()`, so a timer that fires late does not make the wait longer. The signal stops each timer of the chain. A wait thus lasts the time that the caller asks for.

`timeout` runs its time on `delay`, and its disposal aborts that delay. `poll` and `ChangeWatcher` already wait through `delay`. Thus each wait of this package has the same rule, and the rule has one home.

The precedents do the same. `delay` of sindresorhus waits through `unlimited-timeout`, which starts timers of 2^31-1 ms and reads the time that is left from `performance.now()` before each one, and `long-timeout` (used by `node-schedule`) starts a new timer of 2^31-1 ms until the time that is left fits in one timer. `time.Sleep` of Go and `ScheduledExecutorService` of Java take any duration that their types hold.

## Considered Options

- **Refuse a time above 2^31-1 ms in `milliseconds()`.** A poll of 30 days is a correct request, for example a source that changes each month. Each caller would cut its time, as the Search Console source did, and a 30-day request would then wait 24.8 days.
- **Cut the time to 2^31-1 ms.** The wait is shorter than the request, with no error.
- **A chain of timers in `delay`.** This option was selected.

## Consequences

- A wait of any positive, finite time lasts that time. A fake clock moves through the chain with `await clock.tickAsync(ms)`. A synchronous `clock.tick(ms)` fires only the first timer of a chain, because the next timer starts after a microtask.
- The signal of a `timeout` aborts one microtask after its timer fires, not in the callback of the timer.
- elt's Search Console source can remove its cut to 2^31-1 ms when it depends on a release of this package with the chain.
