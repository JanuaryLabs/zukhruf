# A library that waits takes the clock as an input

Many tests depend on time. On 2026-11-02 a census read the tests of 19 repositories and found 2,278 tests that depend on time. The code under test reads the time, measures a duration, or waits on a timer. The tests used real time: they slept, they asserted elapsed times, and some waited 61 or 65 seconds. Some failed at random under load (#3057, #3433, #3515).

Real time can not reach these behaviors in a test:

- A long fixed wait, for example a retry after 10 seconds. The test waits the full time.
- An exact order of timers when the CPU is busy. Real timers race the CPU.
- A check that nothing happened. The test sleeps for a time and can only hope that it was long enough.
- A calendar edge in a part that runs for a long time, for example a lease that ends at midnight.
- A wall clock that jumps while the monotonic clock does not, for example after the computer sleeps.

A test must control time to reach them. For HTTP, msw intercepts the request at the wire, and the product code takes no option for it. Node has no such interception for time in one test. `mock.timers` of `node:test` replaces the globals of the whole process, so it breaks tests that run at the same time ([testing ADR 0009](../../packages/testing/docs/adr/0009-a-test-never-changes-the-environment-of-its-process.md)). It also does not reach `performance.now()`, `process.hrtime()`, `AbortSignal.timeout()`, or a `setTimeout` of `node:timers/promises` that a module imported before the test enabled the mock. A test on Node.js 26.10 showed each of these gaps.

## Decision

A library that waits on a timer or reads the time takes the clock as an input.

- The clock is a required input, the way a lock store is ([mutex ADR 0022](../../packages/mutex/docs/adr/0022-a-database-lock-store-takes-its-session-from-the-caller.md)). It has no default.
- The type of the clock is structural. It has only the members that the library calls. `@zukhruf/async` exports `Clock`, with `setTimeout`, `clearTimeout` and `performance.now()`, and `delay`, a wait of a fixed time on a clock ([async ADR 0005](../../packages/async/docs/adr/0005-a-wait-runs-on-the-clock-that-the-caller-gives.md)). A library that needs more members, for example `Date.now()` or `setInterval`, adds only those members to `Clock`.
- An app or an entry script gives `globalThis`, in its own code. The app does not get a new option for the clock.
- A test gives `createClock()` of `@sinonjs/fake-timers`. This clock does not replace a global. `await clock.tickAsync(ms)` moves the time and fires each timer that is due. `t.waitFor(() => assert.equal(clock.countTimers(), n))` waits until the code under test waits on the clock again. `clock.setSystemTime(time)` moves the wall clock and does not move `performance.now()`.
- A decision about "now", for example whether a lease ended, stays a function that takes the time as an argument. A test of it gives a time and needs no clock.

The write-test skill records this decision as the one exception to its rules "No test seams" and "No fakes" (Ezz, 2026-11-02: "clock as an input"). The exception is only for the clock.

## Considered Options

- **Real time only.** The tests keep the five gaps above. The census found about 350 real sleeps, 76 asserts on elapsed time, and waits of a minute.
- **Global fake timers**: `mock.timers` of `node:test`, `install()` of `@sinonjs/fake-timers`, or `clock-mock`. Each one replaces the globals of the process, so two tests that run at the same time see each other's clock. `mock.timers` also misses the four time sources above.
- **A preload that fakes time in the process of each test file.** The product code does not change. But the tests of that file can not run at the same time, and the test can not get the clock without a global.
- **`@time-provider/core`.** It has a wall clock, a monotonic clock and timers. But its moves are synchronous, so a move can not wait for the work that a timer starts. Its first release was in 2026-06.
- **A `@zukhruf/clock` package with a `systemClock` and a `TestClock`.** `globalThis` already is the system clock, and `createClock()` already is the test clock. The package adds code that does the same work.
- **The `Clock` type of pg-boss.** It has `now()`, but `poll` needs `performance.now()`. The `now` of `createClock()` is a number, not a method, so a sinon clock does not match the pg-boss type. `@zukhruf/sqlite-queue` keeps the pg-boss clock for the parity with pg-boss.
- **The clock as an input, with `createClock()` in tests.** This option was selected.

## Consequences

- The clock enters by layer. `@zukhruf/async` is first (#3570): `poll` and `pollChanges` take the clock, and the six callers in this workspace give it. Then each other library that reads the time takes it, and the lint rule `zukhruf/no-ambient-time` reports a direct read of the time in library code (#3571). The places are in the base layer (`fs`, `docker`), the coordination layer (`election`) and the domain layer (`mutex`, `single-flight`, `pool`, `sqlite-queue`).
- Each consumer repository changes after the release of `@zukhruf/async`: elt (#3572), context-compiler (#3573), deepagents (#3574), text2sql (#3575), theagentlab (#3576) and trashbot (#3577).
- Some code keeps real time. The timing of `@zukhruf/mteb` measures real time, because a benchmark measures real time. `settleWithin` and `timebox` of `@zukhruf/testing` give a test a real deadline. A timer inside a third-party package, for example the 60 second request limit of the MCP SDK, is outside our code.
- Each package whose tests move the clock has `@sinonjs/fake-timers` as a dev dependency. `@zukhruf/async` can not import `@zukhruf/testing` in its tests ([root ADR 0001](./0001-zukhruf-is-a-layered-standard-library.md)), so no shared test clock is possible there, and none is necessary.
- `@zukhruf/testing` gives `globalThis` to the Docker clients of its fixtures, because they wait on a real engine. The options of `Postgres`, `Mysql`, `Mariadb`, `SqlServer` and `ClickHouse` do not take a clock.
- A deadline and the clock must agree. A deadline from `performance.now()` of one clock is wrong for a wait on another clock. The type can not see this, because both are numbers.
