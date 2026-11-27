# The package is @zukhruf/checkpoint, and the SQLite sense of the word is a WAL checkpoint

Status: Accepted 2026-11-28 (backlog #6201). The search below read only the `_Avoid_` lines. The glossary of sqlite-snapshot defined "Checkpoint" in the SQLite sense, and sqlite-snapshot and sqlite-open used the bare word in their READMEs; they say "WAL checkpoint" since 2026-11-28.

Decision-makers: Ezz, on 2026-11-27. Asked for the name, he chose "@zukhruf/checkpoint", with the SQLite sense of the word renamed "WAL checkpoint" in four glossaries.

The leaders name the saved progress of a reader with two words:

| Leader                         | Word for the saved progress                           | Word for its store                  |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------- |
| Event Hubs (.NET and JS)       | checkpoint (`EventProcessorCheckpoint`, `Checkpoint`) | `CheckpointStore`                   |
| Kinesis Client Library         | checkpoint (`checkpoint()`)                           | `Checkpointer`                      |
| Orleans                        | checkpoint                                            | `IStreamCheckpointStore`            |
| Flink                          | checkpoint                                            | `CheckpointStorage`, `StateBackend` |
| Beam                           | `CheckpointMark`                                      | the runner                          |
| Spark                          | checkpoint (`checkpointLocation`)                     | `StateStoreProvider`                |
| Go: `Jeffail/checkpoint`       | checkpoint                                            | none                                |
| Redpanda Connect               | checkpoint (`checkpoint_cache`)                       | `service.Cache`                     |
| Kafka, Kafka Connect, Debezium | offset, committed offset                              | `OffsetBackingStore`, `OffsetStore` |

Sources: survey A (names table), survey B (names table), survey C (names table), 2026-11-27.

Four glossaries of zukhruf list "checkpoint" under `_Avoid_`. Three of them give the SQLite meaning: a WAL checkpoint, which copies the WAL into the database file (SQLite's `PRAGMA wal_checkpoint`, https://www.sqlite.org/pragma.html#pragma_wal_checkpoint). The fourth, snapshot-differential, gives elt's meaning: "an ELT pipeline's word for all saved state".

## Decision

1. The package is `@zukhruf/checkpoint`, in `packages/checkpoint`. The name is singular, because the package is a concept and not a collection.
2. In the glossaries of sqlite-changefeed, sqlite-notify and sqlite-transaction, the SQLite sense is "WAL checkpoint". In the glossary of snapshot-differential, the reason names this package: a checkpoint holds the position and the map states of a reader, and a snapshot is one value of a map state.

## Considered Options

- **`@zukhruf/offset`.** Kafka's word. It keeps "checkpoint" free for SQLite, but eight of the nine leaders above say checkpoint, and an offset is one kind of position (a number), not the whole saved progress with its state.
- **`@zukhruf/progress`, `@zukhruf/cursor`.** No leader names this store so.
- **`@zukhruf/checkpoint`.** This option was selected.

## Consequences

- The glossaries of four packages change their `_Avoid_` lines in the commit of this paper.
- A text about SQLite writes "WAL checkpoint". A text about this package writes "checkpoint".

## Confirmation

- The names tables of surveys A, B and C, 2026-11-27, with pinned source links.
- `grep -n -i checkpoint` over the `CONTEXT.md` files of zukhruf, 2026-11-27: five `_Avoid_` lines in four glossaries (sqlite-changefeed lines 69 and 85, sqlite-notify line 69, sqlite-transaction line 21, snapshot-differential line 25).
