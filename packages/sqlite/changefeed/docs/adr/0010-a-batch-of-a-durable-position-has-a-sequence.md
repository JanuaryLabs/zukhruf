# A batch of a durable position has a sequence

Delivery of a durable feed is at least once (ADR 0004). A host that cannot apply an event two times with no effect must find a batch that comes again. Ambient in context-compiler keeps a fingerprint of each event for this, and a hand-off table for a stop between its journal and its queue.

Kafka gives each record an offset, and Debezium gives each event the position of the log. A consumer keeps the last offset that it applied in the transaction of its own work, and skips a record whose offset it has: an idempotent consumer.

## Decision

- `watch()` gives a `Batch`. It holds the events of one pass in `events`, and a loop iterates it as it iterates an array.
- The position makes the batch, so its kind sets the kind of the batch. A `PositionFile` gives a `SequencedBatch`: its `sequence` is the number of the save that keeps the batch. The file counts its saves in `PRAGMA user_version`, which also tells that a pass saved it. A batch that comes again after a stop has the same sequence.
- A `PositionInMemory` gives a `Batch` with no `sequence`. Its numbers would start again at the next run, so a host that kept one could skip a new batch. The type has no field for it, and the compiler refuses a read of it.
- `Changefeed` is generic over its batch: `Changefeed<SequencedBatch>` for a `PositionFile`.

## Considered Options

- **A sequence on each batch.** A sequence of a position in memory is then a valid value that is wrong at the next run.
- **`{ sequence, events }`, a plain record.** A loop must then read `batch.events`.
- **A `Batch` class, and a `SequencedBatch` only for a durable position.** This option was selected.

## Consequences

- A host can apply each batch one time.
- A pass that gives no batch also saves, so the sequences of the batches have gaps. They only grow.
- A loop that read a batch as an array reads `batch.events`, or iterates the batch.
