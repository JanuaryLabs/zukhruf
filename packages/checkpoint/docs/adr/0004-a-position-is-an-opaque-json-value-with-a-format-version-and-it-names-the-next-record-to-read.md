# A position is an opaque JSON value with a format version, and it names the next record to read

> **Design for review.**

Status: Proposed 2026-11-27 (backlog #6201).

Decision-makers: the zukhruf session mutex-d0, from the surveys of 2026-11-27.

The engines that keep the progress of any input keep the position as a value that they do not read, and they keep a version beside it:

- Kafka Connect: a source offset is a `Map<String, ?>` of primitive values. The connector decides what it means (survey B, item 2a).
- Spark: `abstract class Offset { public abstract String json(); }`, read back with `SparkDataStream.deserializeOffset(String json)` (survey C, Spark a).
- Flink: a split is kept through `SimpleVersionedSerializer<E> { int getVersion(); byte[] serialize(E); E deserialize(int version, byte[] serialized); }` (survey C, Flink d).
- Airbyte: "Nothing outside the Source can make any inference about the state … EXCEPT, if it is null" (survey C, Airbyte a). A state that an older version wrote is migrated with `StateMigration { should_migrate(stream_state); migrate(stream_state) }` (survey C, Airbyte g).

The engines for one system know their position: a Kafka offset is a `long`, an Event Hubs position has an offset and a sequence number. A package for any input cannot know it.

The leaders also agree on what a position means. Kafka: "The committed offset should always be the offset of the next message that your application will read" (survey B, item 1a). Event Hubs resumes after the checkpoint (`EventPosition.FromOffset(offset, false)`, survey A, item 1e). Kinesis gives the next worker "data records whose sequenceNumber > checkpoint position" (survey A, item 3e). Airbyte: "Outputting a state message indicates that all records which came before it have been successfully written to the destination" (survey C, Airbyte e).

## Decision

1. A position is a value of the reader's type `P`. The package keeps it as JSON and never reads it.
2. A `Format<P>` has a `version`, `encode(value)` to JSON, and `decode(version, json)` back to `P`. A commit writes the version beside the JSON. A claim gives the stored version and JSON to `decode`.
3. `decode` reads each version that it can migrate. When it cannot, it throws, and the claim throws `IncompatibleCheckpointError` with that error as its `cause` ([ADR 0012](./0012-the-package-owns-three-error-classes-one-for-each-next-step.md)).
4. Each map state has a format too, for its values ([ADR 0006](./0006-keyed-state-is-a-set-of-named-map-states-and-a-commit-writes-only-what-changed.md)).
5. A position names the next record to read. Each record before it is done. The README and the glossary say so, and a reader that commits the last record read in place of the next one reads that record again.

## Considered Options

- **Bytes, as Flink and Kafka Connect.** JSON is the form of Spark and Airbyte, every store of the package can keep it as text, and a person can read it in the store.
- **A schema in place of `decode`, such as a JSON Schema or a Standard Schema.** A schema checks one shape. A migration needs code that reads an older shape and gives the new one, as Airbyte's `migrate` and Flink's `TypeSerializerSnapshot.migrate`.
- **No version.** Then a change of the shape of a position cannot be told from a corrupt value.
- **JSON with a version, read by the reader's `decode`.** This option was selected.

## Consequences

- Each reader writes one format for its position. A format whose position is already JSON has an `encode` that gives the value as it is.
- The version is a number of the reader. The package compares it with nothing.

## Confirmation

- Survey B, items 1a and 2a; survey A, items 1e and 3e; survey C, Flink d, Spark a, Airbyte a, e and g. 2026-11-27.
