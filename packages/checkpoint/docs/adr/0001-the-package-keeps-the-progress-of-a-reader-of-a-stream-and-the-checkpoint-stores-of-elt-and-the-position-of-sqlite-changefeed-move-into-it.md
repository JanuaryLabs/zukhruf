# The package keeps the progress of a reader of a stream, and the checkpoint stores of elt and the position of sqlite-changefeed move into it

Status: Accepted 2026-11-28 (backlog #6201).

Decision-makers: Ezz, on 2026-11-20 and 2026-11-27, and the zukhruf session mutex-d0 from the surveys of 2026-11-27. Ezz asked for "a stdlib checkpointing package". After a lesson on the two meanings of "checkpoint" in the field, he chose two packages and this one first ("Bookmark first"), public on npm. He also ruled that the package takes its words and its API from the leaders and that the hosts follow it: "Don't be biased to the current implementation in the repositories. You should force those repositories into your proper terminologies and proper API design."

The word "checkpoint" has two meanings in the leading tools:

- **The progress of a reader of a stream.** The input exists outside the program and can be read again from a position. The checkpoint holds the position and the state of the reader. Kafka, Kafka Connect, Event Hubs, Kinesis, Orleans, Flink, Spark, Airbyte and Singer keep it.
- **A journal of the steps of a program (durable execution).** The input is the program itself. The checkpoint holds the result of each step, and a recovery runs the program again and skips the recorded steps. DBOS ("DBOS checkpoints those workflows and steps to a Postgres database", https://docs.dbos.dev/architecture), AWS Lambda durable functions ("a checkpoint/replay mechanism", https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html) and Temporal keep it.

The two make opposite promises. A reader of a stream needs an input that can rewind, and it keeps its output out of the checkpoint. A journal needs a program that runs the same way at each replay (Temporal: "A Workflow Definition must be deterministic to support replay"), and it keeps its output in the checkpoint. A journal of a loop over a long stream grows with each step: Temporal stops a workflow at 51,200 events or 50 MB and gives Continue-As-New, which passes "the latest relevant state" to a new run as its input (https://docs.temporal.io/workflow-execution/limits, https://docs.temporal.io/workflow-execution/continue-as-new). No leader of the surveys gives both behind one API.

In zukhruf and its consumers, the progress of a reader of a stream is kept in these places (survey of 2026-11-20):

- elt: `CheckpointStore` with a store for SQLite, Postgres and SQL Server, a binding check, and keyed entries beside the state (elt ADRs 0035 and 0036). context-compiler uses it through elt.
- `@zukhruf/sqlite-changefeed`: `Position`, `PositionFile` and `PositionInMemory`, which keep the WAL progress and a fingerprint for each row of each table.
- eca and its proactive host: a cursor for each automation in a table of the host.

No standard library has this work. Go's standard library and `golang.org/x` have no checkpoint, offset or cursor store, and neither have the .NET base class library and `Microsoft.Extensions.*` (survey A, item 5; survey B, item 6). Node.js has none: a search of the exports of every built-in module for checkpoint, memento, watermark, resume and journal found only the high-water mark of streams (Node.js 26.13.0).

## Decision

1. `@zukhruf/checkpoint` keeps the progress of a reader of a stream: a checkpoint for each consumer group, stream and partition, with a position, map states and a checkpoint id.
2. Durable execution is a separate package, which comes after this one.
3. elt's `CheckpointStore`, its stores, its binding and the keyed entries of its `STATE` messages move into this package and go away with no alias. elt claims a partition for each copy and commits its stage in the `write` of a commit ([ADR 0007](./0007-a-commit-saves-the-position-the-state-changes-and-the-next-checkpoint-id-together-and-can-write-the-output-in-the-same-transaction.md)).
4. The position of `@zukhruf/sqlite-changefeed` moves into this package. The feed keeps its WAL progress as the position, the fingerprints of each table as a map state, and the sequence of a batch as the checkpoint id (its ADR 0010). Debezium does the same: its connectors keep their own offsets in the generic `OffsetBackingStore` of Kafka Connect, and the default offset store of the Debezium engine is Connect's `FileOffsetBackingStore` (survey B, Debezium items d and 5).
5. The cursors of eca move into this package.
6. `@zukhruf/snapshot-differential` stays as it is. Its state changes become the sets and deletes of a map state.

## Considered Options

- **One package for both meanings.** One side would carry fields that mean nothing to it: a reader of a stream does not keep step outputs, and a journal has no position. No leader of the surveys gives both behind one API.
- **Each host keeps its own checkpoint store.** This is the state of 2026-11-20: three hosts, each with its own words (copy, binding, spaces, entries, position, cursor) and its own faults (#4468, #2409, #5599, #5301).
- **A package on npm.** A search on 2026-11-27 (offset store, stream checkpoint, checkpoint offset, resume token store, cursor store resume, incremental sync state, consumer offset commit, keyed state checkpoint, state backend stream) found only packages for one system (`@azure/event-hubs`, `kafkajs`, `@langchain/langgraph-checkpoint`) or a plain key-value store (`keyv`). The README lists why each one does not fit.
- **The package also commits on a timer.** A commit cadence belongs to the reader, as auto commit belongs to the Kafka consumer (`enable.auto.commit`, `auto.commit.interval.ms`) and the commit policy to the Debezium engine (`OffsetCommitPolicy`) (survey B). The package does not decide when to commit.
- **The package also assigns partitions to workers.** Event Hubs and Kinesis balance partitions over workers with expiring ownership. That is the work of a group coordinator. In zukhruf it is the work of `@zukhruf/election` and `@zukhruf/pool`.
- **One package of this concept that elt's stores and sqlite-changefeed's position move into.** This option was selected.

## Consequences

- elt, sqlite-changefeed and eca each get one migration item after the release. elt ADRs 0035 and 0036 are superseded in part: the keyed entries become map states of this package.
- sqlite-changefeed ADRs 0004, 0007 and 0010 are superseded in part: the feed takes a checkpoint store in place of a `Position`.
- The root ADR 0001 gets `checkpoint` in its base row ([ADR 0013](./0013-the-package-is-in-the-base-layer.md)).
- Savepoints (a store of older checkpoints for a rollback) come later (Ezz, 2026-11-27).

## Confirmation

- Survey A (Event Hubs .NET and JS, Kinesis, Orleans, Go and .NET standard libraries), survey B (Kafka consumer, Kafka Connect, Debezium, franz-go, Jeffail/checkpoint, Redpanda Connect, Go) and survey C (Flink, Kafka Streams, Spark, Airbyte, Singer, Beam), all on 2026-11-27, with pinned commits: `~/.claude/plans/linked-beaming-bird/survey-*.md`.
- The inventory of 2026-11-20 of the places that keep progress in zukhruf, elt, context-compiler, deepagents and agent-plugin.
