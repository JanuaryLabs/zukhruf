# The queue keeps the durability of pg-boss

`@zukhruf/sqlite-open` changed the default of a write-ahead log to `synchronous = NORMAL` (its ADR 0007). With `NORMAL`, SQLite syncs the `-wal` file only before each checkpoint. A power loss can then roll back a `send` that returned a job id.

pg-boss on Postgres does not lose such a job. Postgres returns from a commit after it flushes its write-ahead log, because `synchronous_commit` is `on` by default. A job that `send` acknowledged and that a power loss removes is a divergence ([ADR 0002](./0002-the-parity-suite-is-the-contract.md)). The parity suite cannot find it, because it does not cut the power.

## Decision

- `new SqliteJobQueue({ path })` opens the queue file with `new WriteAheadLog({ synchronous: 'full' })`. SQLite syncs the `-wal` file at each commit.
- `new SqliteJobQueue({ database })` uses the connection of the caller. The README tells the caller to open it with `synchronous: 'full'` for the durability of pg-boss.

## Considered Options

- **The default of `@zukhruf/sqlite-open`, `NORMAL`.** A `send` on Linux is about 5 times faster (1,400–1,700 / s with `FULL`, 8,200 / s with `NORMAL`, ADR 0007 of `@zukhruf/sqlite-open`). But a power loss can remove jobs that the caller saw as sent.
- **An option of the queue for `NORMAL`.** No caller asks for it. A caller that accepts the loss opens its own connection and gives it as `database`.
- **`FULL` for the queue file.** This option was selected.

## Consequences

- A `send`, a `complete` and each other write of the queue file waits for the disk on Linux.
- A caller that gives `database` decides the durability of its jobs.
