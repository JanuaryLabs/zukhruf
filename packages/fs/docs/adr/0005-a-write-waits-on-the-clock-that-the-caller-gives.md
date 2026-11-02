# A write waits on the clock that the caller gives

On Windows, `patiently` runs an operation again while Windows refuses the file for now. It waits between two tries with `setTimeout` of `node:timers/promises`, and it stops after 1 second of `performance.now()`. Each write of this package (`atomicWrite`, `durableWrite` and `createExclusive`) calls `patiently` for its rename or link. Thus each write can wait, and the wait runs on the real clock.

[Root ADR 0004](../../../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md) decides that a library that waits takes the clock as an input. The clock is an input when a caller can give another clock and the code is still correct. Here it can: a test on Windows can give an operation that Windows refuses two times, give a fake clock, and move the time through the two waits and past the 1 second.

## Decision

`patiently` and each write take a required `clock`:

```ts
patiently(operation, { clock })
atomicWrite(path, content, { clock, mode? })
durableWrite(path, content, { clock, mode? })
createExclusive(path, content, { clock })
```

- The type is `Clock` of `@zukhruf/async`. `patiently` waits with `delay` of `@zukhruf/async` on the clock, and its 1 second is a time from `clock.performance.now()`.
- Each write gives its clock to `patiently`.
- Production gives `globalThis`. A test gives `createClock()` of `@sinonjs/fake-timers`.

## Considered Options

- **A clock only on `patiently`, and `globalThis` inside each write.** The writes would choose the real clock for their callers. A caller could not move the wait of a write in a test.
- **A default of `globalThis`.** Root ADR 0004 refuses a default: a caller that forgets the clock waits on the real clock, and only a test finds it.
- **A copy of the type `Clock` in this package, to keep it with no dependency.** The type is one concept of `@zukhruf/async`, and `patiently` also needs `delay`. Both packages are in the base layer of [root ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md), and `@zukhruf/async` has no dependency.
- **A required clock on `patiently` and on each write.** This option was selected.

## Consequences

- `@zukhruf/async` is a dependency of this package.
- Each caller gives a clock. In this workspace: `SqliteElection` of `@zukhruf/election`, `FileTokenSource` of `@zukhruf/fencing`, and the file lock stores and `SqliteStore` of `@zukhruf/mutex`. Each one gives the clock that it already takes, or takes one (#3571).
- Off Windows, `patiently` does not wait, so a test off Windows gives `globalThis` or a fake clock with the same result.
