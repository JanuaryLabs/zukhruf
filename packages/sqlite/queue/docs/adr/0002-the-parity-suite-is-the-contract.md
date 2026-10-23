# The parity suite is the contract

The package promises zero divergence from pg-boss ([ADR 0001](./0001-pg-boss-api-on-sqlite.md)). A test that states the expected result by hand proves only what its author thinks pg-boss does. pg-boss has many behaviors that its documentation does not state, for example the order of a batch, the fields of an `error` event, and the escapes that Postgres refuses in JSON.

Thus the oracle is pg-boss itself. Each parity test runs one scenario two times: on real pg-boss 12.35.1 over an in-memory PGlite, and on this package. Both runs use a pg-boss `TestClock` at the same start time. `Parity.assertSame` deep-compares what the two runs observed, and the test passes only when they are equal. pg-boss runs its own test suite on PGlite too, so PGlite gives the Postgres behavior that pg-boss expects.

The suite ships with the package, in `src/parity`, and runs in `sqlite-queue:test`. PGlite is a dev dependency. The suite is not a step of the port that goes away after the port: each change of the package, and each new version of pg-boss, runs it again.

A scenario can also assert values that it expects, after `assertSame`. These assertions document the behavior. The comparison with pg-boss is the proof.

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
