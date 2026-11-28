# The feed keeps its position in a consumer group of @zukhruf/checkpoint, and the host commits

Status: Accepted 2026-11-28 (backlog #6280).

Decision-makers: the zukhruf session mutex-8c, from the leaders below; Ezz, on the split between an explicit commit and the auto-commit of ADR 0004: "be strict and ruthless. no backward compaility and follow the leaders".

The feed kept its position in a `Position` of its own: a `PositionFile` in a SQLite file of the feed, or a `PositionInMemory` (ADRs 0004 and 0007). It saved the position of a batch when the loop asked for the next batch, as the auto-commit of a Kafka consumer does. A `PositionFile` gave a `SequencedBatch`, so a host could skip a batch that it applied before (ADR 0010).

Three facts made this wrong:

- `@zukhruf/checkpoint` now keeps the progress of a reader of a stream: a position, map states that commit only what changed, a write of the reader's output in the transaction of the commit, and fencing of an older claim (checkpoint ADR 0001). The position of the feed was a second copy of that concept.
- A save at the next request cannot carry a write. The host's output and the position committed in two transactions, so delivery was at least once, and a host that wanted each batch one time kept a sequence in its own transaction.
- A `PositionFile` deleted and wrote again each fingerprint of each table that a pass changed: one changed row of a large table rewrote the whole table.

The leaders commit in the consumer:

- Kafka's consumer gives `commitSync()`, which commits the offsets of the records of the last poll. Its documentation, "Storing Offsets Outside Kafka", writes the offsets in the transaction of the output for exactly once.
- Debezium's embedded engine gives the consumer a `RecordCommitter` (`markProcessed`, `markBatchFinished`). The consumer marks what it processed.
- Kafka Connect exactly-once sources (KIP-618) write the records and the offsets of a source task in one transaction.

## Decision

The host gives the feed a `ConsumerGroup` of `@zukhruf/checkpoint` and a `stream`, and commits each batch with `feed.commit()`.

- `new Changefeed(databasePath, { checkpoints, stream, start })`. The host owns the store of the group. The feed disposes only its data version.
- The feed keeps its checkpoint in partition `'0'` of the stream, because one pass reads every table under one WAL progress. A stream with no parts has one partition (checkpoint README).
- The position is the WAL progress: `Format<WalProgress | null>`, version 1. Its `decode` refuses another version or another shape, so `watch()` rejects with `IncompatibleCheckpointError`.
- The map state `tables` holds the key columns and the columns of each table. The map state `table:<name>` holds one fingerprint for each key. A pass sets the fingerprint of each new or changed key and deletes each key that is gone, so a commit writes only the rows that changed. A dropped table loses its entry in `tables` and its whole map state.
- `watch()` claims the partition, which fences each older claim. The constructor claims nothing, because a claim is async.
- `watch()` gives a `readonly ChangeEvent[]` for each pass, an empty one too, as a Kafka poll gives an empty set of records. A baseline then commits through the same commit.
- A pass goes on from every batch of the watch, also those that no commit saved: their changes wait in the map states of the claim, and the WAL progress of the last batch in the claim. A pass changes the map states only after it read every table.
- `feed.commit({ write, signal })` commits every batch that the watch gave so far. With `write`, the store runs it in the transaction of the commit. Before any batch, it rejects with a `TypeError`. A feed that a newer claim fenced rejects with `CheckpointFencedError`, and runs no write.
- `Position`, `PositionUpdate`, `TablePosition`, `PositionFile`, `PositionInMemory`, `Batch` and `SequencedBatch` are removed, with no alias. A position file of an older version is not read: a host starts with a new consumer group.

## Considered Options

- **Keep the auto-commit at the next request (ADR 0004), and add a commit for exactly once.** Two modes need two types, and the auto-commit cannot carry a write.
- **Keep a sequence on each batch: the checkpoint id.** A `MemoryCheckpointStore` counts its checkpoint ids again in a new process, so a host that kept one would skip new batches: the bug that ADR 0010 made unrepresentable.
- **A feed that owns its store.** The host then cannot write its output in the transaction of the commit.
- **An explicit commit through the consumer group of the host.** This option was selected.

## Consequences

- A host commits after it applied a batch. With no commit, the next run gives every uncommitted batch again: at least once.
- A host whose output is in the database of the store commits it in `write`: exactly once. A `MemoryCheckpointStore` is a `CheckpointStore<never>`, so a feed in memory takes no `write`, and the compiler refuses one (the constraint of ADR 0010).
- A second watch of the same consumer group and stream fences the first. A feed that is made but not watched fences nothing.
- A pass still holds the fingerprints of each table that it reads in memory. A snapshot larger than memory needs keyed reads in `@zukhruf/snapshot-differential`.
- Context Compiler's Ambient moves to `checkpoints`, `stream` and `commit()` after the release (#6285).

## Confirmation

The tests of `src/changefeed.test.ts` (40 tests, `nx run sqlite-changefeed:test --skip-nx-cache`, 2026-11-28):

- "a second feed of the stream fences the first: the commit of the first rejects with CheckpointFencedError and runs no write".
- "a commit whose write throws commits nothing: the store keeps the earlier checkpoint, and the next run gives the batch again".
- "a commit with a write commits the rows of the write and the checkpoint together".
- "a commit after … writes only the fingerprint of that row", for an insert, an update and a delete, on a store over `MemoryCheckpointStore` that records the state changes of each commit; a new watch after the commit then gives an empty batch, so a wrong key or a wrong fingerprint shows as an event (an INSERT and DELETE of another row writes the WAL frames that make the pass read the table again; an UPDATE to the same values writes none).
- "a commit keeps the WAL progress of its last pass as the position of the checkpoint".
- "a checkpoint whose position has another version (another shape) makes the watch reject with IncompatibleCheckpointError".
- "a feed whose checkpoint is in memory takes no write": a `@ts-expect-error` on `commit({ write })`.
- "a dropped table loses its fingerprints and its columns", "one commit after several batches saves them all", "a feed that is built but never watched claims nothing", "a feed of another stream, and a feed of another consumer group, … neither fence the feed nor share its checkpoint", and "the feed does not close the store of the host".
- Each test of the earlier API keeps its claim on the new API; the two tests of `SequencedBatch` are removed with it.

Each of these tests failed under an in-memory mutation of its claim (the write-test skill's `mutate.mjs`, 2026-11-28): 30 mutants, 30 caught, among them a claim with another partition, an auto-commit before the yield, a set or a delete of every key, a delete of another key, a dropped WAL progress, a feed that claims when it is built, and a `write` type that a memory feed accepts (an unused `@ts-expect-error`, TS2578).
