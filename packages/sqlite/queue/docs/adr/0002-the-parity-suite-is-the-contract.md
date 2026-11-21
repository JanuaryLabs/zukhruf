# The parity suite is the contract

The package promises zero divergence from pg-boss ([ADR 0001](./0001-pg-boss-api-on-sqlite.md)). A test that states the expected result by hand proves only what its author thinks pg-boss does. pg-boss has many behaviors that its documentation does not state, for example the order of a batch, the fields of an `error` event, and the escapes that Postgres refuses in JSON.

Thus the oracle is pg-boss itself. Each parity test runs one scenario two times: on real pg-boss 12.38.2 over an in-memory PGlite, and on this package. Both runs use a pg-boss `TestClock` at the same start time. `Parity.assertSame` deep-compares what the two runs observed, and the test passes only when they are equal. pg-boss runs its own test suite on PGlite too, so PGlite gives the Postgres behavior that pg-boss expects.

The suite ships with the package, in `src/parity`, and runs in `sqlite-queue:test`. PGlite is a dev dependency. The suite is not a step of the port that goes away after the port: each change of the package, and each new version of pg-boss, runs it again.

A scenario can also assert values that it expects, after `assertSame`. These assertions document the behavior. The comparison with pg-boss is the proof.

While a run is open, `Date.now` reads the run's `TestClock` (`src/testing/date-follows-clock.ts`; a scenario that builds its engines by hand on a `TestClock` does the same). pg-boss 12.38.1 times a worker's polling round with `Date.now()` and waits the rest of the interval on its clock (#990). On a `TestClock`, the real time of each fetch would then make each poll early by that time, so the two engines' polls would differ with the speed of their fetches. The run's clock is the only time the scenario controls, so the real time of a fetch must not reach a poll. This replaces a global for the length of a run, which root ADR 0004 rejects for tests in general because two tests that run at the same time see each other's clock. A parity file runs its tests one after the other, and each run restores `Date.now` when it closes. The owner chose this on 2026-11-21 over comparing coarser facts of each poll. A wait that must take real time is measured with `performance.now()`. The round timing itself is tested on a clock of real time that jumps back a day, as pg-boss's own test does (`src/parity/work.test.ts`).

## Considered Options

- **Tests with expected values only.** Each value is the guess of its author. A wrong guess passes on both the code and the test.
- **Recorded results of pg-boss, kept as files.** The files go stale when pg-boss changes, and nobody can see why a value is what it is.
- **Real pg-boss on a Postgres server in Docker.** It is the real engine, but each test run needs Docker, and the suite becomes slow.
- **Real pg-boss on PGlite in the same process.** This option was selected.

## Consequences

- A change that gives a divergence fails `sqlite-queue:test`, also when no person knew about that behavior of pg-boss.
- The suite needs a time zone that is not UTC (`TZ=Asia/Kolkata` on the test target), because some behaviors of pg-boss depend on local time.
- The suite takes about one minute, because each scenario runs two times and pg-boss makes its schema on each PGlite.
- When a test of the suite fails, the oracle is correct: the fix goes into this package, not into the test.
