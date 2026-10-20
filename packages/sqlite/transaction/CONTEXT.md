# SQLite transaction

`node:sqlite` has no function that runs work in a transaction. This package runs work in a transaction, commits when the work returns, and rolls back when the work throws. It keeps the original error when SQLite ended the transaction itself.

## Language

**Transaction**:
The changes that SQLite writes together between `BEGIN` and `COMMIT`, or undoes together with `ROLLBACK`.
_Avoid_: Unit of work, batch, session

**Owner**:
The call that starts the transaction because the connection has none. Only the owner commits or rolls back the whole transaction.
_Avoid_: Outer call, root, parent

**Savepoint**:
The part of a transaction that a call works in when the connection already has a transaction. A failure undoes only the changes of the savepoint.
_Avoid_: Nested transaction (SQLite has no nested transactions), sub-transaction, checkpoint (a checkpoint moves the WAL into the database)

**Mode**:
When the owner takes the write lock: `deferred` at the first write, `immediate` at `BEGIN`, `exclusive` at `BEGIN`, and then no other connection can read.
_Avoid_: Isolation level, lock type, behavior

**Automatic rollback**:
A rollback that SQLite does itself after some errors, for example `SQLITE_IOERR` or `RAISE(ROLLBACK)` in a trigger. After it, the connection has no transaction and no savepoints.
_Avoid_: Implicit rollback, abort, silent rollback
