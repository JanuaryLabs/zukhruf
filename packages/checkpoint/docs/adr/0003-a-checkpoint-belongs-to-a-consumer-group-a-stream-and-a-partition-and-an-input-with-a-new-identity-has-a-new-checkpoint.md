# A checkpoint belongs to a consumer group, a stream and a partition, and an input with a new identity has a new checkpoint

Status: Accepted 2026-11-28 (backlog #6201).

Decision-makers: the zukhruf session mutex-d0, from the surveys of 2026-11-27.

Each leader keys the progress of a reader by the reader, the input and the part of the input:

| Leader        | Reader           | Input                                     | Part                   | Source                                                                                                                               |
| ------------- | ---------------- | ----------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Kafka         | `group.id`       | topic                                     | partition              | `TopicPartition`, `committed(Set<TopicPartition>)` (survey B, item 1b)                                                               |
| Event Hubs    | `consumerGroup`  | `fullyQualifiedNamespace`, `eventHubName` | `partitionId`          | `EventProcessorCheckpoint` (survey A, item 1b); blob name `{ns}/{hub}/{group}/checkpoint/{partitionId}`                              |
| Kinesis       | application name | stream name                               | shard (`leaseKey`)     | one lease table per application; multi-stream `leaseKey` `account-id:StreamName:streamCreationTimestamp:ShardId` (survey A, item 3b) |
| Kafka Connect | connector name   | none                                      | `sourcePartition` map  | stored key `[connectorName, partition]` (`OffsetUtils`, survey B, item 2b)                                                           |
| Airbyte       | connection id    | `StreamDescriptor` (name, namespace)      | partitions in the blob | `StatePersistence.getCurrentState(connectionId)` (survey C, addendum)                                                                |

The identity of the input is in the key in each of them. An input that changes its identity has a new key, and so a new checkpoint. No leader keeps a separate check that compares the saved input with the current one: elt's binding check ("Checkpoint binding changed for ${id}; reset it or use a new copy ID") is a host's design, and it gave faults when the code changed what a copy is (#2075, #2116, #2627).

## Decision

1. A checkpoint key has three strings: the consumer group, the stream and the partition (`CheckpointKey`). A store keeps one checkpoint for each key.
2. The consumer group is the name of the reader, as Kafka's `group.id` and the `consumerGroup` of Event Hubs. `ConsumerGroup` takes it in its constructor.
3. A partition is a part of a stream that the reader reads in order. A stream that has no parts has one partition, for example `'0'`, as a Kafka topic with one partition has partition 0.
4. The reader puts each fact of the identity of its input into the stream or the partition. A copy of a SQL Server table to a new destination is a new stream name, so it has a new checkpoint. The package has no binding check.
5. A change of the format of a position is not a change of identity. It is a new version of the format ([ADR 0004](./0004-a-position-is-an-opaque-json-value-with-a-format-version-and-it-names-the-next-record-to-read.md)).

## Considered Options

- **One opaque id for each checkpoint.** Kafka Connect's `sourcePartition` is a map with no stream level. But then a reset of one stream must read every key and match a prefix. Kafka, Event Hubs, Kinesis and Airbyte keep the input as its own level, and the reset tools of Kafka and Airbyte work on one stream (survey C, Kafka Streams g; Airbyte g).
- **A map for the partition, as Kafka Connect.** A map needs a canonical text to be a key. A string is the form of Kafka, Event Hubs and Kinesis, and the reader builds it.
- **A binding check beside the key.** No leader has one. It refuses a checkpoint when code changes, and the host must reset by hand.
- **Three strings in the key.** This option was selected.

## Consequences

- elt makes its stream name and partition from the source identity, the target and the selection of a copy, which its binding holds today. A change of any of them starts a new checkpoint. The old checkpoint stays until a reset.
- sqlite-changefeed names its stream after the database that it follows, and has one partition.

## Confirmation

- Surveys A (items 1b, 2b, 3b, 4b), B (items 1b, 2b, 3b) and C (Airbyte b and the addendum), 2026-11-27.
