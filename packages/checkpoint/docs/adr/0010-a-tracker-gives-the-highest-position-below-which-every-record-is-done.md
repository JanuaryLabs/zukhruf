# A tracker gives the highest position below which every record is done

> **Design for review.**

Status: Proposed 2026-11-27 (backlog #6201).

Decision-makers: the zukhruf session mutex-d0, from the surveys of 2026-11-27.

A reader that handles batches in parallel finishes them out of order. When it commits the position of the last batch that finished, a crash loses the batches before it that were still open. The leaders commit only over a done prefix:

- Go's `Jeffail/checkpoint`: `NewUncapped[T]()`, `Track(payload T, batchSize int64) func() *T`, `Pending() int64`, `Highest() *T`; `NewCapped[T](capacity)`, whose `Track(ctx, payload, batchSize)` "blocks while `pending+batchSize > cap`" and returns `ctx.Err()`. `Highest` is "the latest fully resolved payload in the sequence where all prior sequence checkpoints are also resolved". Redpanda Connect uses it for each Kafka partition and for its CDC inputs (survey B, item 5).
- Kafka Connect `SubmittedRecords`: `committableOffsets()` gives offsets "where every record up to and including the record for each returned offset has been either acknowledged or dropped" (survey B, item 2i).
- Debezium's async engine in `UNORDERED` mode waits on each future in the original order and marks each record processed in that order (survey B, addendum item 6).
- franz-go has no tracker and warns: "It is recommended to always commit records in order (per partition)… you will rewind your commit" (survey B, item 4i).

## Decision

1. `UncappedTracker<P>` and `CappedTracker<P>` follow `Jeffail/checkpoint`'s `Uncapped` and `Capped`, with the names of TypeScript: `track`, `highest` and `pending`.
2. `track(position, size)` records a batch in the order that the reader read it. It gives the function that marks the batch done. The function gives the highest position below which each batch is done, or `undefined` when an earlier batch is still open.
3. `CappedTracker` takes a capacity. Its `track` waits while `pending + size` is more than the capacity, and it rejects with the reason of its `signal` when the signal aborts.
4. A tracker is in memory and commits nothing. The reader commits the position that a tracker gives.

## Considered Options

- **No tracker.** Each parallel reader writes the same list, and an error in it loses data.
- **A tracker inside the commit.** A commit would then need to know the order of the batches, which only the reader knows.
- **The names `Capped` and `Uncapped`.** In Go the package name qualifies them (`checkpoint.Capped`). A TypeScript import has no qualifier, so the names say what they are.
- **Two trackers after Jeffail/checkpoint.** This option was selected.

## Consequences

- A reader that reads one batch at a time needs no tracker.

## Confirmation

- Survey B (items 2i, 4i, 5 and addendum items 6 and 7), 2026-11-27: `https://github.com/Jeffail/checkpoint/blob/f7faea5ad1fb7f1e9657676ae3e882568f31f0ca/` `uncapped.go` and `capped.go`.
