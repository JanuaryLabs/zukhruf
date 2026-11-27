# A commit saves the position, the state changes and the next checkpoint id together, and can write the output in the same transaction

> **Design for review.**

Status: Proposed 2026-11-27 (backlog #6201).

Decision-makers: the zukhruf session mutex-d0, from the surveys of 2026-11-27.

A reader writes its output to a destination and its checkpoint to a store. When the two commit apart, a crash between them reads records again or loses them. Singer: "Interrupted jobs that save state too early will have data missing … too late … duplicate rows" (survey C, Singer e). The leaders give two forms:

- **The checkpoint after the output, alone.** Event Hubs, Kinesis and the Kafka consumer commit the position after the reader handled the records, and their docs say the delivery is at least once (survey A, items 1e and 3e; survey B, item 1e).
- **The checkpoint and the output in one transaction.** The Kafka consumer docs, "Storing Offsets Outside Kafka": keep "both the offset and the indexed data together", for exactly once (survey B, item 1c). Kafka Streams under `exactly_once_v2`: "commits on the input topic offsets, updates on the state stores, and writes to the output topics will be completed atomically", through `sendOffsetsToTransaction` (survey C, Kafka Streams e and the addendum). Kafka Connect exactly-once sources write the offsets in the producer transaction: `offsetWriter.beginFlush()`, then `doFlush`, then `producer.commitTransaction()` (survey B, item 2e).

In each engine, the state and the position commit together: a Flink checkpoint is one snapshot of the positions and the state (survey C, Flink e), and Spark writes the offsets of a batch, then its state, then the batch to its commit log (survey C, Spark e). Each commit also has a number that grows: Flink "Checkpoint IDs are strictly increasing", and Spark's `StateStore.commit()` gives "the new version" (survey C).

In Kafka Streams and Kafka Connect, the engine owns the transaction and runs the output in it. Thus the engine fences a zombie in the same transaction: a producer that a newer one replaced gets `ProducerFencedException`, and its transaction aborts with its output (survey B, items 1f and 2f).

## Decision

1. `context.commit(position, options)` writes, in one transaction of the store: the check of the epoch ([ADR 0008](./0008-a-newer-claim-fences-an-older-one-and-a-commit-of-a-fenced-claim-throws-and-writes-nothing.md)), the `write` of the options when there is one, the position with the version of its format, the changes of each map state, and the next checkpoint id. All of them commit or none of them.
2. The store owns the transaction. The `write` gets the connection of that transaction: the `DatabaseSync` for the SQLite store, the session of the transaction for the Postgres and SQL Server stores. The memory store has no transaction for an output, so its `write` type is `never`.
3. The `write` runs after the check of the epoch. A fenced reader writes no output.
4. With no `write`, the commit is alone. The reader commits its output first and the checkpoint after it. The delivery is at least once.
5. The first commit of a partition gives checkpoint id 1, and each commit gives one more. The commit resolves with the new checkpoint.
6. A commit that throws leaves the checkpoint and the map states of the store as they were, and keeps the changes of the context.

## Considered Options

- **Only the commit alone.** It is enough for an idempotent destination, but a destination in the database of the store can have exactly once at no cost, and the leaders give it.
- **The caller's transaction, with the checkpoint inside it.** The caller would begin the transaction and pass it to the commit. Then the package cannot order the check of the epoch before the output, and a fenced reader can commit its output. Kafka Streams and Kafka Connect own the transaction for this reason.
- **A two-phase commit with an outside destination, as Flink's `Committer`.** It needs a destination that can prepare and commit. A destination in the database of the store needs no second phase.
- **A store-owned transaction that runs the output after the epoch check.** This option was selected.

## Consequences

- elt passes the commit of its stage as the `write`: the rows of a page and the checkpoint commit in one transaction, when the destination and the store share a database.
- A destination in another database still commits apart: the delivery is at least once, and the destination dedupes, as elt's `append_dedup` does today.
- The `write` of the SQLite store is sync, because `node:sqlite` is sync. The store refuses a `write` that gives a promise, as `transaction` of `@zukhruf/sqlite-transaction` does.

## Confirmation

- Survey A (items 1e, 3e), survey B (items 1c, 1e, 1f, 2e, 2f), survey C (Flink e, Kafka Streams e and the addendum, Spark e, Singer e), 2026-11-27.
- `@zukhruf/sqlite-transaction` `transaction`: a work that returns a promise throws "A transaction function cannot return a promise" (`packages/sqlite/transaction/src/transaction.ts`).
