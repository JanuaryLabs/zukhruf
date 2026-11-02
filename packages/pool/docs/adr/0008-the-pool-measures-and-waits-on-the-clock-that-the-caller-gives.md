# The pool measures and waits on the clock that the caller gives

The pool reads `performance.now()` to measure each job for its sizing, to know when it last resized, and to know whether a worker ran 10 minutes before it exited. It starts a `setTimeout` for the back-off before it replaces a worker that exited early ([ADR 0005](./0005-an-eager-pool-backs-off-before-it-replaces-a-worker-that-exited-early.md)), and `IdleTimeout` starts one for each idle worker ([ADR 0006](./0006-the-pool-evicts-an-idle-worker-that-its-eviction-lets-go-and-lends-an-idle-worker-first.md)). All of these read the real clock, so the tests of the pool waited real time: the windows of 2 seconds of the sizings that learn made one test file take about 5 minutes, and the back-off tests replaced the global timers with `mock.timers` of `node:test`.

[Root ADR 0004](../../../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md) decides that a library that waits on a timer or reads the time takes the clock as an input.

## Decision

- `new Pool({ ..., clock })` takes a required `clock` of type `Clock` of `@zukhruf/async`. Each time that the pool reads and each timer that it starts uses this clock. Production gives `globalThis`.
- An eviction gets the clock of the pool: `idle(busy, evict, clock)`. `IdleTimeout` waits with `delay` of `@zukhruf/async` on that clock. Thus the pool and its eviction run on one clock, and a caller can not give them two.
- A sizing takes no clock. `Climbing` gets each time in the `Sample` that the pool records, so it decides from the times that the pool gives, as root ADR 0004 says for a decision about "now".

## Considered Options

- **A clock on `IdleTimeout` too.** Each class that waits would take its own clock. But a test could then give the pool a fake clock and the eviction the real clock, and the idle timer would run on real time. One clock that the pool passes on makes that state impossible.
- **A clock on each sizing.** A sizing reads no time: the pool measures, and the sizing compares the samples.
- **`capacity()` (free memory and the CPU count) and the jitter of the pause (`Math.random`) as inputs too.** They are not time, so root ADR 0004 does not cover them. Capacity as an input is a separate step (#3599).
- **The clock of the pool on a required option, and the clock of the eviction from the pool.** This option was selected.

## Consequences

- Each caller of `new Pool()` gives `clock: globalThis`.
- An eviction of a caller takes a third argument. `NoEviction` ignores it.
- The tests of the pool give `createClock()` and move it, so a back-off, an idle timeout or a sizing window takes no real time.
