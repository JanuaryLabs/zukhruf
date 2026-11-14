# Identical notifications of one transaction are not folded

Postgres folds identical notifications: "If the same channel name is signaled multiple times with identical payload strings within the same transaction, only one instance of the notification event is delivered to listeners" (the NOTIFY page, C7). Its code keeps a list of the pending notifications of each transaction and subtransaction. A failed subtransaction discards its list, and a successful one merges its list into its parent's and drops the duplicates (`async.c:355-380`).

To fold, the sender must know where its transaction begins and ends, and which savepoints rolled back. `node:sqlite` reports none of this: it has no commit hook (research 19 §2). `database.isTransaction` tells only that a transaction is open now. Two transactions that run one after the other in one synchronous run of code look the same to `notify` as one transaction.

## Decision

C7 is not given. Each call of `notify` is one row and one notification.

A fold that guesses the scope of a transaction can fold a notification of one transaction into a notification of another, or into one whose savepoint rolled back. Then a committed notification is lost. A duplicate costs a listener one more notification. Postgres's other lines promise that a committed notification is delivered, so a duplicate is the safe side.

## Considered Options

- **Fold in memory until the next microtask.** Two transactions in one run of code fold into one, and a notification of a rolled-back savepoint can fold away a later one that commits.
- **Fold in SQL against the rows of the current transaction.** The sender cannot tell the rows of its own transaction from rows that an earlier transaction of the same run committed, without a read on a second connection inside the transaction.
- **No fold.** This option was selected.

## Consequences

- A caller that sends the same channel and payload twice in one transaction delivers two notifications. A caller that needs one sends one.
- pg-boss sends one `pg_notify` from each statement that makes a job runnable, and treats it as "only ever a latency hint" (`pg-boss/dist/notifier.js:8-11`). A duplicate costs it one more fetch.
- A later version of `node:sqlite` with a commit hook could give C7. That is a new decision.
