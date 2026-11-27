# The package has a memory store and stores for SQLite, Postgres and SQL Server, and a host can write its own

> **Design for review.**

Status: Proposed 2026-11-27 (backlog #6201).

Decision-makers: the zukhruf session mutex-d0, from the surveys of 2026-11-27.

The leaders separate the store from the reader, and they ship several stores behind one port:

| Leader        | Port                                                                                                          | Stores it ships                                                                                | Source                 |
| ------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------- |
| Event Hubs    | `CheckpointStore`: `ListOwnershipAsync`, `ClaimOwnershipAsync`, `GetCheckpointAsync`, `UpdateCheckpointAsync` | blob, table, in memory                                                                         | survey A, items 1d, 2d |
| Kinesis       | `Checkpointer` (`setCheckpoint`, `prepareCheckpoint`) and `LeaseRefresher`                                    | DynamoDB                                                                                       | survey A, item 3d      |
| Orleans       | `IStreamCheckpointStore`: `Load`, `Update(checkpoint, expectedVersion)`                                       | DynamoDB, Azure Table, Redis, grain                                                            | survey A, item 4d      |
| Kafka Connect | `OffsetBackingStore`: `get`, `set`, `connectorPartitions`, `start`, `stop`, `configure`                       | memory, file, Kafka topic                                                                      | survey B, item 2d      |
| Debezium      | `OffsetStore` and `OffsetStoreProvider`                                                                       | file, JDBC, Kafka, Redis, S3, Azure blob, NATS, RocketMQ, RocksDB, config map, Chronicle Queue | survey B, item 3d      |
| Flink         | `StateBackend`, `CheckpointStorage`                                                                           | HashMap, RocksDB, ForSt                                                                        | survey C, Flink d      |

In zukhruf, `@zukhruf/retrieval` and `@zukhruf/embedding-cache` give one entry point for each SQL engine (`./sqlite`, `./postgres`, `./sqlserver`), and their SQL stores take a session port that the host writes over its own driver (retrieval `PostgresSession`, `SqlServerSession`). The hosts of this package keep their progress in SQLite (elt, sqlite-changefeed), Postgres (elt's warehouse) and SQL Server (elt).

## Decision

1. `CheckpointStore<W>` is the port. `ConsumerGroup` is its only caller. `W` is the type of the `write` of a commit ([ADR 0007](./0007-a-commit-saves-the-position-the-state-changes-and-the-next-checkpoint-id-together-and-can-write-the-output-in-the-same-transaction.md)).
2. The port has `claim`, `read`, `get`, `scan`, `commit`, `list` and `reset`. `claim` and `reset` raise the epoch of a key in one atomic write. `commit` checks the epoch, runs the write and writes the checkpoint and the state changes in one transaction, and throws `CheckpointFencedError` when the stored epoch is newer.
3. `@zukhruf/checkpoint` gives `MemoryCheckpointStore`, whose `W` is `never`.
4. `@zukhruf/checkpoint/sqlite` gives `SqliteCheckpointStore` over a `DatabaseSync` that the host opens. Its tables live in that database, so a destination in the same file commits with the checkpoint. Its transaction is `transaction` of `@zukhruf/sqlite-transaction`.
5. `@zukhruf/checkpoint/postgres` and `@zukhruf/checkpoint/sqlserver` give a store over a session that the host writes over its own driver. The session has `query`, as the sessions of `@zukhruf/retrieval`, and `transaction(work)`, which runs the work on one connection in one transaction.
6. Each store keeps two tables: one row for each checkpoint key (epoch, checkpoint id, version, position), and one row for each key, state name and value key (version, value).
7. A host can write a store for another engine. The README section "Write your own store" gives the rules of the port.

## Considered Options

- **One store, SQLite.** A destination in Postgres or SQL Server could not commit its output with its checkpoint.
- **A store for each driver, such as postgres.js and node-postgres.** A session port lets each host keep its driver, as `@zukhruf/retrieval` does.
- **A store of bytes, as Kafka Connect and Debezium.** A store of bytes cannot read one key of one map state, so each read of a large state would read all of it.
- **A memory store and three SQL stores behind one port.** This option was selected.

## Consequences

- The session ports of `@zukhruf/retrieval` have `query` and no `transaction`. The build step counts the copies of these session ports in zukhruf (retrieval, embedding-cache and this package) and follows the Rule of Three for them.
- A store creates its tables when it starts. Its tables change with a new version of the package through `@zukhruf/sqlite-drift` for SQLite.

## Confirmation

- Survey A (items 1d, 2d, 3d, 4d), survey B (items 2d, 3d), survey C (Flink d), 2026-11-27.
- `packages/retrieval/src/postgres/postgres-session.ts` and `packages/retrieval/src/sqlserver/sqlserver-session.ts`: the session ports have only `query`.
