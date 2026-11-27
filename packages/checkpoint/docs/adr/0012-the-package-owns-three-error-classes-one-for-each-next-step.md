# The package owns three error classes, one for each next step

Status: Accepted 2026-11-28 (backlog #6201).

Decision-makers: the zukhruf session mutex-d0, from the surveys of 2026-11-27.

A reader handles an error of a checkpoint by what it does next: stop, change its format, reset, or retry. The leaders give a class for each of these:

- **Stop: another owner took the partition.** Kinesis `ShutdownException` ("Another instance may have started processing… abort"), Kafka `CommitFailedException`, Kafka Streams `TaskMigratedException` ("can be thrown when the thread gets fenced… a 'zombie'") (survey A, item 3h; survey B, item 1h; survey C, Kafka Streams f and i).
- **Change the format or reset: the saved state does not fit.** Flink `StateMigrationException` and `TypeSerializerSchemaCompatibility.incompatible()`, Spark `STATE_STORE_KEY_SCHEMA_NOT_COMPATIBLE` and `STATE_STORE_VALUE_SCHEMA_NOT_COMPATIBLE` (survey C, Flink g and i, Spark g).
- **Reset: the saved state is broken.** Kafka Streams `TaskCorruptedException`, "if the checkpoint file does not contain offsets" (survey C, Kafka Streams i). Event Hubs JS `Error("Missing metadata property 'offset'…")` (survey A, item 2h).
- **Retry: the store cannot be reached.** Kinesis `KinesisClientLibDependencyException` ("backoff and retry"); Event Hubs re-throws the error of the store to the caller (survey A, items 1h and 3h).

elt throws a plain `TypeError` for a busy checkpoint (#5599) and for a changed binding, so a host cannot tell them apart from a fault of its own code.

## Decision

1. `CheckpointFencedError`: a commit found a newer epoch ([ADR 0008](./0008-a-newer-claim-fences-an-older-one-and-a-commit-of-a-fenced-claim-throws-and-writes-nothing.md)). It holds the checkpoint key and the epoch of the context. The reader stops.
2. `IncompatibleCheckpointError`: `decode` of a format threw for a stored version ([ADR 0004](./0004-a-position-is-an-opaque-json-value-with-a-format-version-and-it-names-the-next-record-to-read.md)). It holds the key, the version and the error of `decode` as its `cause`. The reader migrates in `decode`, or resets.
3. `CorruptCheckpointError`: a stored row is not a valid record of the store, for example its JSON does not parse. It holds the key. Only a reset repairs it.
4. The error of a driver goes to the caller as it is. The package does not wrap it, because the next step of an unknown error is the same: the reader can retry.

## Considered Options

- **One error class with a code.** A reader would switch on a code in place of `instanceof`, and a new code would pass silently through an old switch.
- **A class for an unreachable store.** Its next step is the next step of any unknown error. The package would wrap every error of every driver.
- **One class for incompatible and corrupt.** Their next steps differ: a new version of `decode` repairs an incompatible checkpoint, and only a reset repairs a corrupt one.
- **Three classes, and the driver's errors as they are.** This option was selected.

## Consequences

- elt's busy `TypeError` and its binding refusal go away: the first becomes a fence of the older run, and the second becomes a new checkpoint key ([ADR 0003](./0003-a-checkpoint-belongs-to-a-consumer-group-a-stream-and-a-partition-and-an-input-with-a-new-identity-has-a-new-checkpoint.md)).

## Confirmation

- Survey A (items 1h, 2h, 3h), survey B (item 1h), survey C (Flink g and i, Spark g, Kafka Streams f and i), 2026-11-27.
