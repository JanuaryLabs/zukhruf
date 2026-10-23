# pg-boss's API on SQLite

A program that sends jobs to a queue needs an engine that keeps the jobs. pg-boss keeps them in Postgres. A program with no Postgres server, for example a desktop app, needs another engine. When the other engine has its own API, a program that runs on both engines needs two sets of code, or a layer of its own above them.

Thus this package does not make a new API. It gives the API of pg-boss: the same method names, options, results, events and errors. The types come from pg-boss, and `PgBoss` satisfies `JobQueue` with no adapter. A program changes its engine where it makes the queue, and keeps the rest of its code. Oban does the same for Elixir: its Basic engine uses Postgres and its Lite engine uses SQLite, and the API of Oban does not change with the engine.

The API is a declared subset: the 13 methods that `JobQueue` lists. A method enters the subset only with its parity tests ([ADR 0002](./0002-the-parity-suite-is-the-contract.md)). A method outside the subset does not exist, so a program cannot call a method that gives a different result here. A whole copy of the API at once was not possible: each method of pg-boss reads Postgres behavior, for example `SKIP LOCKED`, `json_to_recordset` and the casts of `timestamptz`, and each one needs its own port and its own proof.

The port copies the behavior of pg-boss 12.35.1, and each part cites the lines of pg-boss that it copies. pg-boss is a runtime dependency with an exact version, because the parity suite proved zero divergence against that version and no other. Some values of pg-boss, for example `policies`, `scheduleKinds` and the `systemClock`, come from pg-boss itself.

The package moved from the text2sql repository, at commit 8ef6525f (packages `queue/sqlite` and `queue/parity`). In the move, its internals changed to the design rules of this workspace: a phase is a state object, not a flag or an optional field, and an operation in flight is a one-shot latch, not a promise in a field. Data that `work()` and `findJobs()` give is `unknown`, not a type argument that the caller picks. The same 170 tests (17 unit tests and 153 parity tests) passed before and after these changes, with the same scenarios and the same assertions.

## Considered Options

- **A new API for a SQLite queue.** A program that also runs on Postgres then needs code for two APIs.
- **An API of our own, with one adapter for pg-boss and one for SQLite.** Each program learns a third API, and each change of pg-boss needs a change of the adapter.
- **The whole API of pg-boss at once.** Each method needs a port and a proof, so the work does not end before some methods give a different result.
- **A declared subset of the API of pg-boss.** This option was selected.

## Consequences

- A program uses the documentation of pg-boss for each method in the subset.
- A method joins the subset only with parity tests for it.
- A new version of pg-boss is a change of this package: the parity suite runs against the new version before the pin moves.
- A behavior that only SQLite has, for example a file that the queue owns, has unit tests, not parity tests.
