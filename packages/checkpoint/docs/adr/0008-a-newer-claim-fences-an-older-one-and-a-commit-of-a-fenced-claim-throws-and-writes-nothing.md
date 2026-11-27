# A newer claim fences an older one, and a commit of a fenced claim throws and writes nothing

> **Design for review.**

Status: Proposed 2026-11-27 (backlog #6201).

Decision-makers: the zukhruf session mutex-d0, from the surveys of 2026-11-27.

Two readers that commit one partition overwrite each other. A reader that a restart replaced can still run, for example a process that froze and woke later. elt's checkpoint stores hold a session lock for each copy, and they fail in two ways: a lock of Postgres goes away when postgres.js connects again, and the run goes on with no lock (#2409, #5301); a second run gets a plain `TypeError` "Checkpoint … is in use by another run" (#5599).

The leaders give the owner of a partition a number, and they refuse a commit of an older owner:

| Leader         | Owner                                                           | A commit after a newer owner                                                                                                             | Source                         |
| -------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| Kinesis        | the lease row: `leaseOwner`, `leaseCounter`, `concurrencyToken` | refused: `ShutdownException` "Can't update checkpoint - instance doesn't hold the lease for this shard"                                  | survey A, item 3f              |
| Kafka consumer | the generation of the group                                     | refused: `CommitFailedException`, "a safety mechanism which guarantees that only active members of the group are able to commit offsets" | survey B, item 1f              |
| Kafka Streams  | the producer epoch                                              | refused: `TaskMigratedException`, "Producer got fenced trying to add offsets to a transaction"                                           | survey C, addendum             |
| Kafka Connect  | the task generation and transactional id                        | refused: the new task "will automatically fence out its single predecessor"                                                              | survey B, addendum item 2      |
| Spark          | the run id                                                      | refused: the atomic write of a batch file fails, and `stopActiveRunOnRestart` stops the older run                                        | survey C, Spark f and addendum |
| Orleans        | a lease of the queue balancer                                   | only an optional compare-and-swap on the version of the checkpoint                                                                       | survey A, item 4f and addendum |
| Event Hubs     | an ETag claim of the partition                                  | not refused: the checkpoint write has no condition                                                                                       | survey A, items 1f and 2f      |

The leaders split on who wins. Kinesis and Event Hubs balance partitions over many workers: a claim waits until the ownership of the owner expires, which needs a clock and a renewal (Kinesis `failoverTimeMillis`, Event Hubs `PartitionOwnershipExpirationInterval` of 2 minutes). Spark, Kafka Connect and the Kafka producer replace the old owner at once: a new run fences the old one. `@zukhruf/pool` chose the same for its revisions: the newest revision takes over (pool ADR 0022).

## Decision

1. A claim raises the epoch of its key in one atomic write of the store, and the context keeps the new epoch. The epoch is a `FencingToken` of `@zukhruf/fencing`.
2. The newest claim owns the partition. A claim never waits and never expires, and the package has no clock.
3. A commit checks, in its transaction, that the stored epoch is the epoch of the context. When the stored epoch is newer, the commit throws `CheckpointFencedError` and writes nothing: no position, no state, no output ([ADR 0007](./0007-a-commit-saves-the-position-the-state-changes-and-the-next-checkpoint-id-together-and-can-write-the-output-in-the-same-transaction.md)).
4. A fenced context stays fenced. The reader stops, and the package does not retry.
5. A reset raises the epoch too, so it fences the live owner ([ADR 0009](./0009-a-consumer-group-lists-and-resets-its-checkpoints-and-a-reset-fences-the-live-owner.md)).

## Considered Options

- **A lease that expires, as Kinesis and Event Hubs.** It is the design for many workers that share partitions. A reader of zukhruf is one logical reader that its host restarts. A lease needs a clock, a renewal and a wait at each restart, and the work of balancing belongs to a group coordinator ([ADR 0001](./0001-the-package-keeps-the-progress-of-a-reader-of-a-stream-and-the-checkpoint-stores-of-elt-and-the-position-of-sqlite-changefeed-move-into-it.md)).
- **A lock for each partition, as elt.** A lock of a session goes away silently with its connection (#2409, #5301), and a busy lock refuses the newer run, which is the run that the host wants.
- **A claim with no check at the commit, as Event Hubs.** A replaced reader overwrites the newer checkpoint.
- **An epoch that a newer claim raises, checked in the transaction of each commit.** This option was selected.

## Consequences

- A host that must not replace a live run checks that itself, for example with a lock of `@zukhruf/mutex`, before it claims.
- A replaced reader reads until its next commit. Its reads are harmless, because its commit writes nothing.

## Confirmation

- Survey A (items 1f, 2f, 3f, 4f and the addendum), survey B (items 1f, 2f and addendum item 2), survey C (Spark f, Kafka Streams f and the addendum), 2026-11-27.
- `@zukhruf/fencing` `FencingToken`: "Grows with every grant. A resource that rejects writes carrying a token older than the newest it has seen ignores holders that were superseded without knowing it" (`packages/fencing/src/fencing-token.ts`).
- Pool ADR 0022: "the newest revision takes over".
