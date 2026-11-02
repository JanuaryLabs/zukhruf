# A token source reads the clock that the caller gives

Two token sources depend on time. `MonotonicClockTokenSource` reads `process.hrtime.bigint()` for each token. `FileTokenSource` writes each counter with `durableWrite` of `@zukhruf/fs`, and on Windows that write waits between two tries of a refused rename. [Root ADR 0004](../../../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md) decides that a library that waits on a timer or reads the time takes the clock as an input. [The ADR 0005 of `@zukhruf/fs`](../../../fs/docs/adr/0005-a-write-waits-on-the-clock-that-the-caller-gives.md) gives each write a required clock.

## Decision

- `new FileTokenSource(directory, { clock })`. The type is `Clock` of `@zukhruf/async`. The source gives the clock to `durableWrite`. Production gives `globalThis`.
- `new MonotonicClockTokenSource({ clock })`. The type is `MonotonicClock`: `{ hrtime: { bigint(): bigint } }`, the one member that the source reads. Production gives `process`. Its tokens keep their order across the worker threads of a process only with `process`, because only the clock of the process is one clock for all threads.

## Considered Options

- **`clock.performance.now()` for `MonotonicClockTokenSource`, with the `Clock` of `@zukhruf/async`.** Each worker thread has its own `performance.timeOrigin`, so the times of two threads are not in one order. The source would lose the property that it exists for.
- **`createClock()` of `@sinonjs/fake-timers` as the test clock of `MonotonicClockTokenSource`.** The fake clock has `hrtime.bigint()` at run time, but the types of `@sinonjs/fake-timers` 15.4.0 declare `hrtime` without `bigint`, so the type check refuses it. No test needs a fake monotonic clock now: the tests give `process`.
- **A clock for each token source, with the members that it calls.** This option was selected.

## Consequences

- `@zukhruf/async` is a dependency of this package, for the type `Clock`.
- `FileLockStore` of `@zukhruf/mutex` gives its own clock to its default `FileTokenSource`.
- A caller that makes a `FileTokenSource` or a `MonotonicClockTokenSource` gives the clock (#3571).
