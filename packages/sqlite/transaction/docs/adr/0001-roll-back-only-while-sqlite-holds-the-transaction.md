# Roll back only while SQLite holds the transaction

Each SQLite store of the first callers wrote `BEGIN`, `COMMIT` and `ROLLBACK` itself, in about 23 copies. After some errors, SQLite can roll back the transaction itself: for example after `SQLITE_FULL`, `SQLITE_IOERR`, or `RAISE(ROLLBACK)` in a trigger. The SQLite documentation tells this in "Response To Errors Within A Transaction". Then the `ROLLBACK` of the copy fails with `cannot rollback - no transaction is active`, and that error replaces the original error. The caller sees the error of the rollback, not the cause.

The copies got different fixes at different times. context-compiler added an `if (db.isTransaction)` guard before its `ROLLBACK` (commits ab09484 on 2026-09-27, and 563f374 on 2026-10-07). deepagents put the `ROLLBACK` in a `try`/`catch` that ignores each error (commit 62b15432 and others, 2026-10-07). The copies in text2sql and in the settings store of context-compiler got no fix.

A savepoint has the same problem. When SQLite ends the transaction, its savepoints are gone too. Then `ROLLBACK TO` fails with `no such savepoint`, and that error replaces the original error. The savepoint of `@zukhruf/sqlite-drift` had no guard.

Thus `transaction` rolls back only while `database.isTransaction` is true. This applies to the `ROLLBACK` of the owner and to the `ROLLBACK TO` of a savepoint. Then it throws the original error, as it is. When SQLite still holds the transaction and the rollback fails, the error of the rollback goes to the caller. That failure is a new problem, and the caller must see it.

## Considered Options

- **Ignore each error of `ROLLBACK`, as deepagents does.** It keeps the original error. But it also hides a rollback that failed while SQLite held the transaction. Then the connection stays in a transaction, and the next `BEGIN` fails with an error that tells nothing of the cause.
- **Throw a `SuppressedError` that holds both errors.** It loses no error. But after an automatic rollback, the error of the rollback tells nothing new, and each caller must unwrap the original error to read it.
- **No guard.** The caller sees `cannot rollback` or `no such savepoint` in place of the cause. This is the problem.
- **A guard with `isTransaction`, as context-compiler does.** This option was selected. It does a rollback only when there is a transaction to roll back.

## Consequences

- After an automatic rollback, the caller gets the original error, from the owner and from a savepoint.
- A rollback that fails while SQLite holds the transaction still throws its own error.
- The stores of the first callers can replace their copies with this function. `@zukhruf/sqlite-drift` uses it already.
