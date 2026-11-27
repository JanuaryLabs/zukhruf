# A claim gives the saved checkpoint or none, and the reader picks its start when it has none

> **Design for review.**

Status: Proposed 2026-11-27 (backlog #6201).

Decision-makers: the zukhruf session mutex-d0, from the surveys of 2026-11-27.

Each leader tells a fresh start from a restore, and none lets the store choose the start of the input:

- Flink calls `Source.createEnumerator(ctx)` on a fresh start and `restoreEnumerator(ctx, checkpoint)` on a restore. A function asks `isRestored()` on its `FunctionInitializationContext` (survey C, Flink a and h).
- Event Hubs: `GetCheckpointAsync` gives `null` when the partition has no checkpoint, and the processor then uses `DefaultStartingPosition` (survey A, items 1d and 1g).
- Kafka Connect: `OffsetStorageReader.offset(partition)` gives `null`, and "the connector picks its own start" (survey B, item 2g).
- Airbyte and Singer: a null state means "start at the beginning" (survey C, Airbyte h, Singer h).

The words of a start belong to the input: Kafka `auto.offset.reset` (`earliest`, `latest`, `by_duration`, `none`), Event Hubs `EventPosition` (`Earliest`, `Latest`, `FromOffset`, `FromEnqueuedTime`), Kinesis `InitialPositionInStream` (`LATEST`, `TRIM_HORIZON`, `AT_TIMESTAMP`), Debezium `snapshot.mode` (survey A, survey B). A package for any input cannot know "the first record" of a SQL Server table or of a mailbox.

## Decision

1. `group.claim(partition, format)` takes the partition ([ADR 0008](./0008-a-newer-claim-fences-an-older-one-and-a-commit-of-a-fenced-claim-throws-and-writes-nothing.md)) and reads its checkpoint. It resolves with a partition context.
2. `context.checkpoint` is the saved checkpoint, `{ position, checkpointId }`, or `undefined` when the partition has no checkpoint. A `Checkpoint` has no field that is empty on a fresh start.
3. The reader picks its start when `context.checkpoint` is `undefined`. The package has no start option.
4. The map states of a fresh partition are empty.

## Considered Options

- **A start option of the package, such as `earliest` or `latest`.** Those are words of one kind of input. The package does not read the input.
- **A discriminated union `{ restored: false } | { restored: true; position; checkpointId }`.** It holds the same facts as an optional checkpoint, with one more field.
- **An optional checkpoint, as Event Hubs gives `null`.** This option was selected.

## Consequences

- A reader writes its start once: `context.checkpoint?.position ?? start`.

## Confirmation

- Survey C (Flink a and h, Airbyte h, Singer h), survey A (items 1d, 1g, 2g, 3g), survey B (items 1g, 2g, 3g), 2026-11-27.
