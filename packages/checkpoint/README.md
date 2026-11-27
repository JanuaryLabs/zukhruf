# @zukhruf/checkpoint

> **Being built (backlog #6201).** The maintainer approved this API on 2026-11-27. `ConsumerGroup`, `PartitionContext`, the map states, the errors and `MemoryCheckpointStore` exist. The trackers and the SQLite, Postgres and SQL Server stores come next.

Keep how far a reader of a stream got, so that it can resume after a stop or a crash. A **checkpoint** belongs to one consumer group, one stream and one partition of that stream. It holds a position, which names the next record to read, and the keyed state of the reader, which a commit saves as changes. A commit saves the position, the state changes and the next checkpoint id together, and it can write the output of the reader in the same transaction. A newer claim of a partition fences the older one, so a reader that a restart replaced cannot commit.

The package replaces the checkpoint stores of elt and the position of `@zukhruf/sqlite-changefeed`, which move here ([ADR 0001](./docs/adr/0001-the-package-keeps-the-progress-of-a-reader-of-a-stream-and-the-checkpoint-stores-of-elt-and-the-position-of-sqlite-changefeed-move-into-it.md)).

The package has four entry points. `@zukhruf/checkpoint` has `ConsumerGroup`, the store port, the memory store, the trackers and the errors. `@zukhruf/checkpoint/sqlite`, `@zukhruf/checkpoint/postgres` and `@zukhruf/checkpoint/sqlserver` each have the store of one engine.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/checkpoint
```

```ts
import { DatabaseSync } from 'node:sqlite';

import { ConsumerGroup, type Format } from '@zukhruf/checkpoint';
import { SqliteCheckpointStore } from '@zukhruf/checkpoint/sqlite';

type Position = { readonly above: string };

const positionFormat: Format<Position> = {
  version: 1,
  encode: (position) => position,
  decode: (version, json) => {
    if (version !== 1) throw new TypeError(`Unknown version ${version}`);
    return json as Position;
  },
};

const database = new DatabaseSync('copy.sqlite');
const group = new ConsumerGroup(
  'mail-copy',
  new SqliteCheckpointStore({ database }),
);

const context = await group.claim(
  { stream: 'messages', partition: 'inbox' },
  positionFormat,
);
let from = context.checkpoint?.position ?? { above: '0' };
for await (const page of readMessages(from)) {
  await context.commit(page.next, {
    write: (database) => insertRows(database, page.rows),
  });
  from = page.next;
}
```

`readMessages` and `insertRows` are the reader's own code. The rows and the position commit in one SQLite transaction, or neither does.

## Resume a reader from its checkpoint

`group.claim(partition, format)` takes the partition for this reader and reads its checkpoint ([ADR 0005](./docs/adr/0005-a-claim-gives-the-saved-checkpoint-or-none-and-the-reader-picks-its-start-when-it-has-none.md)).

- `context.checkpoint` is the checkpoint that the claim read: its `position` and its `checkpointId`. It is `undefined` when the partition had no checkpoint. Then the reader picks its own start, for example the first record or the newest one. It does not change after a commit, as Flink gives the restored checkpoint only once; each commit resolves with the new checkpoint.
- The position names the next record to read. Each record before it is done ([ADR 0004](./docs/adr/0004-a-position-is-an-opaque-json-value-with-a-format-version-and-it-names-the-next-record-to-read.md)).
- The package never reads the position. The `format` writes it as JSON with a version, and reads it back.

A partition is a part of a stream that the reader reads in order, such as a mailbox, a table or a shard. A stream that has no parts has one partition, for example `'0'`. An input with a new identity is a new stream or a new partition, so it has a new checkpoint ([ADR 0003](./docs/adr/0003-a-checkpoint-belongs-to-a-consumer-group-a-stream-and-a-partition-and-an-input-with-a-new-identity-has-a-new-checkpoint.md)).

## Keep keyed state beside the position

`context.state(name, format)` gives a map state: one value for each key, kept with the checkpoint ([ADR 0006](./docs/adr/0006-keyed-state-is-a-set-of-named-map-states-and-a-commit-writes-only-what-changed.md)).

```ts
const seen = context.state('seen', fingerprintFormat);

if ((await seen.get(row.key)) !== row.fingerprint) changed.push(row);
seen.set(row.key, row.fingerprint);
```

- `get`, `has` and `entries` read the committed values and the changes of this context. They are async: a store reads a key when it is asked, so the state can be larger than memory.
- `set`, `delete` and `clear` change the state in memory. The next commit saves only these changes.
- Each name is one map state. Two map states of one partition never share a key.

## Commit the output and the checkpoint together

`context.commit(position, options)` saves the position, the changes of each map state and the next checkpoint id, all of them or none of them ([ADR 0007](./docs/adr/0007-a-commit-saves-the-position-the-state-changes-and-the-next-checkpoint-id-together-and-can-write-the-output-in-the-same-transaction.md)). It resolves with the new checkpoint.

- With `write`, the store runs the write in the transaction of the commit, after it checks the epoch. The output and the checkpoint commit together. A fenced reader writes no output.
- With no `write`, the commit is alone. The reader commits its output first, then the checkpoint. A crash between the two reads the last records again: delivery is at least once.
- The type of `write` comes from the store. The SQLite store gives the `DatabaseSync` of its database. The Postgres and SQL Server stores give the session of the transaction. The memory store takes no `write`.

## Stop a reader that a newer claim replaced

Each claim of a partition gets a new epoch. The newest claim owns the partition ([ADR 0008](./docs/adr/0008-a-newer-claim-fences-an-older-one-and-a-commit-of-a-fenced-claim-throws-and-writes-nothing.md)).

```ts
try {
  await context.commit(next);
} catch (error) {
  if (error instanceof CheckpointFencedError) return; // a newer run reads this partition now
  throw error;
}
```

- A commit checks the epoch in its transaction. When a newer claim or a reset took the partition, the commit throws `CheckpointFencedError` and writes nothing, also no output.
- No claim waits and no claim expires. A restart claims the partition again, and the reader of the old run stops at its next commit.

## Change the format of a position

The `format` of a position or of a map state has a version. A commit writes the version beside the JSON. A claim gives the stored version to `decode` ([ADR 0004](./docs/adr/0004-a-position-is-an-opaque-json-value-with-a-format-version-and-it-names-the-next-record-to-read.md)).

- To change a format, raise its `version`, and let `decode` read each older version that it can migrate.
- When `decode` throws, the claim or the read throws `IncompatibleCheckpointError`, with the error of `decode` as its cause. Then migrate in `decode`, or reset the partition.

## List and reset the checkpoints of a consumer group

```ts
for await (const checkpoint of group.list({ stream: 'messages' }))
  console.log(checkpoint.partition, checkpoint.checkpointId);

await group.reset({ stream: 'messages', partition: 'inbox' });
```

- `list` gives the checkpoint of each partition, with no position and no state ([ADR 0009](./docs/adr/0009-a-consumer-group-lists-and-resets-its-checkpoints-and-a-reset-fences-the-live-owner.md)).
- `reset` removes the checkpoint and the state of one partition, or of each partition of a stream. It fences the live owner first, so the owner cannot commit an old position after the reset.

## Find the position when records finish out of order

A reader that handles records in parallel can finish them out of order. The checkpoint must not pass a record that is not done. A tracker gives the highest position below which each record is done ([ADR 0010](./docs/adr/0010-a-tracker-gives-the-highest-position-below-which-every-record-is-done.md)).

```ts
const tracker = new CappedTracker<Position>(1000);

const done = await tracker.track(batch.next, batch.records.length);
await handle(batch);
const position = done();
if (position) await context.commit(position);
```

- `track(position, size)` records a batch in the order that the reader read it, and gives the function that marks it done.
- The function marks the batch done and gives the highest position below which each batch is done, or `undefined` while no batch is done from the first one on. A batch that ends while an earlier one is open does not move it, as `Highest` of `Jeffail/checkpoint` does not.
- `CappedTracker` waits in `track` while more than its capacity is open. `UncappedTracker` never waits.

## Write your own store

A store is an implementation of `CheckpointStore` ([ADR 0011](./docs/adr/0011-the-package-has-a-memory-store-and-stores-for-sqlite-postgres-and-sql-server-and-a-host-can-write-its-own.md)). `ConsumerGroup` is the only caller of a store.

- `claim` raises the epoch of a key in one atomic write and gives the new epoch.
- `commit` checks the epoch, runs the write, and writes the position, the version, the checkpoint id and the state changes, in one transaction. It throws `CheckpointFencedError` when the stored epoch is newer.
- `get` and `scan` read the values of one map state. `read` reads the stored checkpoint.
- `list` and `reset` work on the keys of one consumer group.

## Errors

| Error                         | When                                                                                                                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CheckpointFencedError`       | A commit of a context whose epoch is older than the stored epoch: a newer claim or a reset took the partition. The commit wrote nothing. The reader stops. It does not retry.         |
| `IncompatibleCheckpointError` | `decode` of a format threw for a stored version. The error of `decode` is its `cause`. Migrate the version in `decode`, or reset the partition.                                       |
| `CorruptCheckpointError`      | A stored checkpoint or value is not a valid record of the store: its JSON does not parse, or a field is missing. Only a reset repairs it.                                             |
| The error of the driver       | The store cannot reach its database. The package does not wrap it ([ADR 0012](./docs/adr/0012-the-package-owns-three-error-classes-one-for-each-next-step.md)). The reader can retry. |

## What the package does not do

- **It does not decide when to commit.** The reader commits after each page, each batch or each interval. A commit cadence belongs to the reader, as auto commit belongs to the Kafka consumer and the commit policy to the Debezium engine ([ADR 0001](./docs/adr/0001-the-package-keeps-the-progress-of-a-reader-of-a-stream-and-the-checkpoint-stores-of-elt-and-the-position-of-sqlite-changefeed-move-into-it.md)).
- **It does not assign partitions to workers.** A claim takes a partition, and a newer claim takes it from an older one. Load balancing over workers is the work of a group coordinator, such as `@zukhruf/election` or `@zukhruf/pool`.
- **It does not know the start of a stream.** "The first record", "the newest record" and "a time" are words of the input. The reader picks its start when `context.checkpoint` is `undefined`.
- **It does not keep old checkpoints.** A commit replaces the checkpoint. A store of older checkpoints for a rollback (savepoints) comes later (Ezz, 2026-11-27).
- **It does not replay the steps of a program.** A journal of step results is durable execution, which is the work of a separate package.

## Who uses it

No code yet. Each consumer moves after the release, with a migration item in its repository ([ADR 0001](./docs/adr/0001-the-package-keeps-the-progress-of-a-reader-of-a-stream-and-the-checkpoint-stores-of-elt-and-the-position-of-sqlite-changefeed-move-into-it.md)).

| Consumer                     | How                                                                                                                                                                                            | Record |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| elt                          | `CheckpointStore`, its SQLite, Postgres and SQL Server stores, the binding and the keyed entries of a `STATE` message go away. A copy claims its partition and commits its stage in `write`.   | #6201  |
| `@zukhruf/sqlite-changefeed` | `Position`, `PositionFile` and `PositionInMemory` go away. The WAL progress is the position, the fingerprints of each table are a map state, and the sequence of a batch is the checkpoint id. | #6201  |
| eca and its proactive host   | The cursor of each automation is the position of a checkpoint.                                                                                                                                 | #6201  |

## The same concepts in other systems

| Concept                      | Other systems                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Checkpoint store             | Event Hubs `CheckpointStore` ([.NET](https://github.com/Azure/azure-sdk-for-net/blob/9841bf0096d377f09c976fea5c201ffe9606b4ff/sdk/eventhub/Azure.Messaging.EventHubs/src/Primitives/CheckpointStore.cs)), Kinesis `Checkpointer`, Orleans `IStreamCheckpointStore`, Kafka Connect `OffsetBackingStore`, Debezium `OffsetStore` |
| Consumer group and partition | Kafka `group.id` and `TopicPartition`, Event Hubs `consumerGroup` and `partitionId`, Kinesis application and shard                                                                                                                                                                                                             |
| Position                     | Kafka committed offset ("the offset of the next message"), Event Hubs `CheckpointPosition`, Kafka Connect source offset, Spark `Offset`                                                                                                                                                                                        |
| Format with a version        | Flink `SimpleVersionedSerializer`, Airbyte `StateMigration`                                                                                                                                                                                                                                                                    |
| Map state                    | Flink `MapState`, Spark `MapState`, Kafka Streams `KeyValueStore`                                                                                                                                                                                                                                                              |
| Commit of changes only       | Flink incremental checkpoints and the changelog, Kafka Streams changelog topics, Spark delta files                                                                                                                                                                                                                             |
| Output in the commit         | Kafka `sendOffsetsToTransaction`, Kafka Streams exactly-once, Kafka Connect exactly-once sources (KIP-618)                                                                                                                                                                                                                     |
| Epoch and fencing            | Kinesis lease counter (`ShutdownException`), Kafka `CommitFailedException` and `ProducerFencedException`, Kafka Streams `TaskMigratedException`, Kafka Connect zombie fencing                                                                                                                                                  |
| Reset                        | Kafka Connect `DELETE /connectors/{name}/offsets` (KIP-875), Airbyte `eraseState`, Singer `reset_stream`                                                                                                                                                                                                                       |
| Tracker                      | Go `Jeffail/checkpoint` `Capped` and `Uncapped`, Kafka Connect `SubmittedRecords`                                                                                                                                                                                                                                              |

No package on npm does this work for any store. Each candidate of the search on 2026-11-27 fails one requirement:

| Package                            | Why it does not fit                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `@azure/event-hubs` and its stores | Only for Event Hubs. No keyed state. A checkpoint write does not check the owner.     |
| `kafkajs`, `kafka-node`            | Only for Kafka. The broker is the store.                                              |
| `@langchain/langgraph-checkpoint`  | The state of a graph per thread, not the position of a reader of a stream.            |
| `keyv`                             | A key-value store. No position, no commit of a position and state together, no owner. |

## API

```ts
// @zukhruf/checkpoint
// @zukhruf/checkpoint/sqlite
import type { DatabaseSync } from 'node:sqlite';

import type { FencingToken } from '@zukhruf/fencing';

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

/** How a value is written as JSON and read back (Flink's SimpleVersionedSerializer). */
export type Format<T> = {
  readonly version: number;
  encode(value: T): Json;
  /** Reads a value that `version` wrote. Throws when it cannot. */
  decode(version: number, json: Json): T;
};

export type StreamPartition = {
  readonly stream: string;
  readonly partition: string;
};

export type Checkpoint<P> = {
  readonly position: P;
  /** One more with each commit of the partition. */
  readonly checkpointId: number;
};

export interface MapState<V> {
  get(
    key: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<V | undefined>;
  has(
    key: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<boolean>;
  entries(options?: {
    readonly signal?: AbortSignal;
  }): AsyncIterable<[key: string, value: V]>;
  set(key: string, value: V): void;
  delete(key: string): void;
  clear(): void;
}

export class PartitionContext<P, W> {
  readonly consumerGroup: string;
  readonly stream: string;
  readonly partition: string;
  readonly epoch: FencingToken;
  /** The checkpoint that the claim read; undefined when there was none. */
  readonly checkpoint: Checkpoint<P> | undefined;
  state<V>(name: string, format: Format<V>): MapState<V>;
  commit(
    position: P,
    options?: { readonly write?: W; readonly signal?: AbortSignal },
  ): Promise<Checkpoint<P>>;
}

export type CheckpointSummary = {
  readonly stream: string;
  readonly partition: string;
  readonly checkpointId: number;
  readonly epoch: FencingToken;
};

export class ConsumerGroup<W> {
  constructor(name: string, store: CheckpointStore<W>);
  readonly name: string;
  claim<P>(
    partition: StreamPartition,
    format: Format<P>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<PartitionContext<P, W>>;
  list(options?: {
    readonly stream?: string;
    readonly signal?: AbortSignal;
  }): AsyncIterable<CheckpointSummary>;
  reset(
    target: { readonly stream: string; readonly partition?: string },
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
}

// The store port. ConsumerGroup is its only caller.
export type CheckpointKey = StreamPartition & {
  readonly consumerGroup: string;
};

export type StoredValue = { readonly version: number; readonly json: Json };

export type StoredCheckpoint = StoredValue & { readonly checkpointId: number };

export type StateChanges = {
  readonly cleared: ReadonlySet<string>;
  readonly set: ReadonlyMap<string, ReadonlyMap<string, StoredValue>>;
  readonly deleted: ReadonlyMap<string, ReadonlySet<string>>;
};

export interface CheckpointStore<W> {
  claim(
    key: CheckpointKey,
    options?: { readonly signal?: AbortSignal },
  ): Promise<FencingToken>;
  read(
    key: CheckpointKey,
    options?: { readonly signal?: AbortSignal },
  ): Promise<StoredCheckpoint | undefined>;
  get(
    key: CheckpointKey,
    state: string,
    keys: readonly string[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<ReadonlyMap<string, StoredValue>>;
  scan(
    key: CheckpointKey,
    state: string,
    options?: { readonly signal?: AbortSignal },
  ): AsyncIterable<[string, StoredValue]>;
  commit(
    key: CheckpointKey,
    epoch: FencingToken,
    checkpoint: StoredCheckpoint,
    changes: StateChanges,
    options?: { readonly write?: W; readonly signal?: AbortSignal },
  ): Promise<void>;
  list(
    consumerGroup: string,
    options?: { readonly stream?: string; readonly signal?: AbortSignal },
  ): AsyncIterable<CheckpointSummary>;
  reset(
    consumerGroup: string,
    target: { readonly stream: string; readonly partition?: string },
    options?: { readonly signal?: AbortSignal },
  ): Promise<void>;
}

export class MemoryCheckpointStore implements CheckpointStore<never> {}

export class UncappedTracker<P> {
  track(position: P, size: number): () => P | undefined;
  highest(): P | undefined;
  readonly pending: number;
}

export class CappedTracker<P> {
  constructor(capacity: number);
  track(
    position: P,
    size: number,
    options?: { readonly signal?: AbortSignal },
  ): Promise<() => P | undefined>;
  highest(): P | undefined;
  readonly pending: number;
}

export class CheckpointFencedError extends Error {
  readonly key: CheckpointKey;
  readonly epoch: FencingToken;
}
export class IncompatibleCheckpointError extends Error {
  readonly key: CheckpointKey;
  readonly version: number;
}
export class CorruptCheckpointError extends Error {
  readonly key: CheckpointKey;
}

export class SqliteCheckpointStore implements CheckpointStore<
  (database: DatabaseSync) => void
> {
  constructor(options: { readonly database: DatabaseSync });
}

// @zukhruf/checkpoint/postgres
export type PostgresSession = {
  query(
    sql: string,
    parameters: readonly unknown[],
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly Record<string, unknown>[]>;
  transaction<T>(work: (session: PostgresSession) => Promise<T>): Promise<T>;
};
export class PostgresCheckpointStore implements CheckpointStore<
  (session: PostgresSession) => Promise<void>
> {
  constructor(options: {
    readonly session: PostgresSession;
    readonly schema?: string;
  });
}

// @zukhruf/checkpoint/sqlserver
export type SqlServerSession = {
  query(
    sql: string,
    parameters: Readonly<Record<string, unknown>>,
    options?: { readonly signal?: AbortSignal },
  ): Promise<readonly Record<string, unknown>[]>;
  transaction<T>(work: (session: SqlServerSession) => Promise<T>): Promise<T>;
};
export class SqlServerCheckpointStore implements CheckpointStore<
  (session: SqlServerSession) => Promise<void>
> {
  constructor(options: {
    readonly session: SqlServerSession;
    readonly schema?: string;
  });
}
```

## Documentation

**Decisions**

- [ADR 0001](./docs/adr/0001-the-package-keeps-the-progress-of-a-reader-of-a-stream-and-the-checkpoint-stores-of-elt-and-the-position-of-sqlite-changefeed-move-into-it.md): the package keeps the progress of a reader of a stream, and the checkpoint stores of elt and the position of sqlite-changefeed move into it.
- [ADR 0002](./docs/adr/0002-the-package-is-zukhruf-checkpoint-and-the-sqlite-sense-of-the-word-is-a-wal-checkpoint.md): the package is `@zukhruf/checkpoint`, and the SQLite sense of the word is a WAL checkpoint.
- [ADR 0003](./docs/adr/0003-a-checkpoint-belongs-to-a-consumer-group-a-stream-and-a-partition-and-an-input-with-a-new-identity-has-a-new-checkpoint.md): a checkpoint belongs to a consumer group, a stream and a partition, and an input with a new identity has a new checkpoint.
- [ADR 0004](./docs/adr/0004-a-position-is-an-opaque-json-value-with-a-format-version-and-it-names-the-next-record-to-read.md): a position is an opaque JSON value with a format version, and it names the next record to read.
- [ADR 0005](./docs/adr/0005-a-claim-gives-the-saved-checkpoint-or-none-and-the-reader-picks-its-start-when-it-has-none.md): a claim gives the saved checkpoint or none, and the reader picks its start when it has none.
- [ADR 0006](./docs/adr/0006-keyed-state-is-a-set-of-named-map-states-and-a-commit-writes-only-what-changed.md): keyed state is a set of named map states, and a commit writes only what changed.
- [ADR 0007](./docs/adr/0007-a-commit-saves-the-position-the-state-changes-and-the-next-checkpoint-id-together-and-can-write-the-output-in-the-same-transaction.md): a commit saves the position, the state changes and the next checkpoint id together, and can write the output in the same transaction.
- [ADR 0008](./docs/adr/0008-a-newer-claim-fences-an-older-one-and-a-commit-of-a-fenced-claim-throws-and-writes-nothing.md): a newer claim fences an older one, and a commit of a fenced claim throws and writes nothing.
- [ADR 0009](./docs/adr/0009-a-consumer-group-lists-and-resets-its-checkpoints-and-a-reset-fences-the-live-owner.md): a consumer group lists and resets its checkpoints, and a reset fences the live owner.
- [ADR 0010](./docs/adr/0010-a-tracker-gives-the-highest-position-below-which-every-record-is-done.md): a tracker gives the highest position below which every record is done.
- [ADR 0011](./docs/adr/0011-the-package-has-a-memory-store-and-stores-for-sqlite-postgres-and-sql-server-and-a-host-can-write-its-own.md): the package has a memory store and stores for SQLite, Postgres and SQL Server, and a host can write its own.
- [ADR 0012](./docs/adr/0012-the-package-owns-three-error-classes-one-for-each-next-step.md): the package owns three error classes, one for each next step.
- [ADR 0013](./docs/adr/0013-the-package-is-in-the-base-layer.md): the package is in the base layer.
