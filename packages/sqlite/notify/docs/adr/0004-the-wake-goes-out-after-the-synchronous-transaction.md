# The wake goes out after the synchronous transaction

Postgres signals the listeners after the commit (`AtCommit_Notify`, `async.c:70-80`). `node:sqlite` has no commit hook: its `Database` has no update, commit or WAL hook (research 19 §2, read in the prototype of Node 26.13.0). So `notify` cannot learn when the caller's transaction commits.

The family has a rule that gives the same moment. "`work` must be synchronous. `node:sqlite` is synchronous, and a transaction cannot stay open across an `await`" (`packages/sqlite/transaction/README.md`). A transaction of the family begins and ends in one synchronous run of code.

## Decision

`notify(channel, payload)` is synchronous:

- When the sending connection is in a transaction (`database.isTransaction`), it inserts the row in that transaction. When it is not, it inserts the row in a `BEGIN IMMEDIATE` transaction of its own, through `@zukhruf/sqlite-transaction`.
- It reads the addresses of the channel in the same transaction, after the insert.
- It queues the wakes on the next microtask. A microtask runs only after the synchronous code that called `notify` has returned, and by then the transaction has committed or rolled back.

A rollback leaves a wake that finds no row. The listener reads nothing and gives nothing to its caller. So C2 holds at the API: a caller never sees a notification of a transaction that rolled back.

## Considered Options

- **A method that runs the transaction, `notifications.transaction(work)`.** It knows the commit. But the family already has `transaction` of `@zukhruf/sqlite-transaction`, and a host's transaction does more than notify.
- **The caller calls a second method after its commit.** A caller that forgets it sends no wake, and the backstop delivers up to 1 s late with no error.
- **The wake on the next turn of the event loop (`setImmediate`).** It comes later than a microtask, and gives nothing more: the transaction ended already.
- **The wake on the next microtask.** This option was selected.

## Consequences

- `notify` works in the caller's transaction, a savepoint of `transaction` too, and in a transaction of its own.
- A transaction that breaks the family's rule and stays open across an `await` gets its wake before its commit. The wake finds no row, and the backstop finds the row up to one second after the commit. The notification is late, never lost.
- A rollback costs each listener of the channel one empty read.
- A program that exits before the microtask sends no wake. The backstop of each listener finds the row.
