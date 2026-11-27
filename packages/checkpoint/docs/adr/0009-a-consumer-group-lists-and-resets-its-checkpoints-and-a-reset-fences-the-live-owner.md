# A consumer group lists and resets its checkpoints, and a reset fences the live owner

Status: Accepted 2026-11-28 (backlog #6201).

Decision-makers: the zukhruf session mutex-d0, from the surveys of 2026-11-27.

A reader must start again when its input was rebuilt, when its format cannot migrate, or when a person wants a full read. The leaders give a list and a reset:

- Kafka Connect (KIP-875): `GET /connectors/{name}/offsets`, `DELETE /connectors/{name}/offsets`, `PATCH /connectors/{name}/offsets`. Under exactly once, a reset first "will fence out all previously-running tasks for the connector… before invoking alterOffsets", and a reset passes "every known source partition… each with a null value" (survey B, item 2g and addendum item 3).
- Airbyte: `StatePersistence.eraseState(connectionId)`, and a reset of one stream "without affecting the state of any other stream" (survey C, Airbyte g and the addendum).
- Singer: `reset_stream` (survey C, Singer c).
- Event Hubs: `listCheckpoints(namespace, hub, consumerGroup)` (survey A, item 2d).
- Kafka Streams: the reset tool resets the input offsets "by default to the beginning" and removes the internal topics (survey C, Kafka Streams g).

elt has `reset(id)` and `clear(id, drop)` today, and a binding refusal tells the host to "reset it or use a new copy ID" (#2627).

## Decision

1. `group.list({ stream })` gives a `CheckpointSummary` for each partition of the consumer group, or of one stream: the stream, the partition, the checkpoint id and the epoch. It reads no position and no state.
2. `group.reset({ stream, partition })` removes the checkpoint and the map states of one partition. `group.reset({ stream })` removes them for each partition of the stream.
3. A reset raises the epoch of each key that it removes, in the same write. Thus the live owner is fenced, and it cannot commit an old position after the reset ([ADR 0008](./0008-a-newer-claim-fences-an-older-one-and-a-commit-of-a-fenced-claim-throws-and-writes-nothing.md)). The next claim starts fresh.
4. A reset of a key that has no checkpoint changes nothing and does not throw.

## Considered Options

- **A reset that removes the row, epoch and all.** The live owner's next commit would find no row, and a store that writes a new row then would accept an old position. Kafka Connect fences before it resets.
- **A list that reads the positions.** A position is opaque to the package, and a list for a person or a tool needs only the keys and the numbers.
- **A reset of a whole consumer group.** Kafka Connect resets a whole connector, but its offsets have no stream level. A host resets each stream of `list`.
- **A list of summaries and a reset that fences.** This option was selected.

## Consequences

- A store keeps a fenced key with its epoch and no checkpoint after a reset, so that the epoch keeps growing.
- elt's `clear(id, drop)` becomes the host's drop of its target, then `group.reset`.

## Confirmation

- Survey B (item 2g, addendum item 3), survey C (Airbyte g and the addendum, Singer c, Kafka Streams g), survey A (item 2d), 2026-11-27.
