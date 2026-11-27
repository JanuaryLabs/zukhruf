# Checkpoint

How far a reader of a stream got, kept so that the reader can resume after a stop or a crash. The package owns where a checkpoint is kept, how it commits, and who may commit it. The meaning of a position and of each value of the state comes from the reader.

## Language

### The checkpoint

**Checkpoint**:
The saved progress of one reader in one partition: a position, a checkpoint id and the map states. Event Hubs (`EventProcessorCheckpoint`), Kinesis (`checkpoint()`), Orleans and Flink use the word. A commit replaces it.
_Avoid_: Offset (Kafka's word for a position), state (for the whole checkpoint), memento, bookmark, WAL checkpoint (SQLite's copy of the WAL into the database file)

**Consumer group**:
The name of one reader of a stream, as Kafka's `group.id` and the `consumerGroup` of Event Hubs. Two consumer groups that read one stream keep two checkpoints of each partition.
_Avoid_: Copy, connection, job, reader id

**Stream**:
An ordered input that a reader can read again from a position: a log, a change feed of a database, a paged API. Kinesis, Airbyte and Singer use the word.
_Avoid_: Topic (Kafka's word for one kind of stream), source

**Partition**:
A part of a stream that a reader reads in order, such as a mailbox, a table or a shard. A stream that has no parts has one partition. Kafka (`TopicPartition`) and Event Hubs (`partitionId`) use the word.
_Avoid_: Split (Flink's word), shard (Kinesis's word for its partitions)

**Checkpoint key**:
The consumer group, the stream and the partition of one checkpoint. A store keeps one checkpoint for each key, as Kafka Connect keeps one offset for each connector and source partition.
_Avoid_: Binding, address, id

**Position**:
Where the reader goes on: the next record to read. Each record before it is done. The package keeps it as JSON and never reads it. Kafka: "the offset of the next message that your application will read".
_Avoid_: Cursor, offset, watermark (a watermark is a time, not a place in a stream)

**Format**:
How a value goes to JSON and back: a version, `encode` and `decode`. A commit writes the version beside the JSON, and `decode` reads each version that it can migrate. After Flink's `SimpleVersionedSerializer`.
_Avoid_: Codec, serializer, schema

**Checkpoint id**:
The number of a commit of one partition. The first commit gives 1, and each commit gives one more. Flink: "Checkpoint IDs are strictly increasing".
_Avoid_: Sequence, version (a version belongs to a format)

### The owner

**Claim**:
The act that takes a partition for a reader. It gives a new epoch and reads the checkpoint.
_Avoid_: Lock, lease (a claim never expires)

**Epoch**:
The fencing token of a claim. Each claim of a key gets a newer epoch than the last. A store refuses a commit whose epoch is older than the stored one.
_Avoid_: Generation, lease counter, version

**Fenced**:
Said of a claim whose epoch is older than the stored epoch, because a newer claim or a reset took the partition. A fenced claim commits nothing.
_Avoid_: Revoked, lost, stale

**Partition context**:
What a claim gives: the checkpoint key, the epoch, the checkpoint, the map states and the commit. Event Hubs gives a `PartitionContext` with `updateCheckpoint` for the same work.
_Avoid_: Session, handle, run

### The state

**Map state**:
The values of one name in a partition, one value for each key. Flink and Spark use the word. Reads are async. Changes stay in memory until the next commit.
_Avoid_: Entries, space, cache, store (a store keeps checkpoints)

**State name**:
The name of one map state of a partition. Two map states never share a key.
_Avoid_: Space, namespace, collection

### The commit

**Commit**:
The act that saves the position, the changes of each map state and the next checkpoint id, all of them or none of them. Kafka, Kafka Streams and Spark use the word.
_Avoid_: Flush, update, checkpoint (as a verb)

**Write**:
The output of the reader that a commit runs in its own transaction, after it checks the epoch. Thus the output and the checkpoint commit together.
_Avoid_: Callback, hook, sink

**Reset**:
The removal of the checkpoint and the state of a partition, or of each partition of a stream. A reset fences the live owner first. Kafka Connect: "reset".
_Avoid_: Clear (a map state clears its keys), delete, erase

### The parts

**Checkpoint store**:
Where checkpoints are kept: memory, a SQLite database, a Postgres or a SQL Server database. `ConsumerGroup` is its only caller.
_Avoid_: Backend, repository, storage

**Session**:
The port through which the Postgres or the SQL Server store sends its SQL: `query`, and `transaction`, which runs work on one connection in one transaction. The host writes it over its own driver, as for the sessions of `@zukhruf/retrieval`.
_Avoid_: Client, connection, driver

**Tracker**:
A record of the batches that a reader handles out of order. It gives the highest position below which each batch is done. A capped tracker waits while more than its capacity is open. After Go's `Jeffail/checkpoint`.
_Avoid_: Ack list, window
