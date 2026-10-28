# One snapshot for each pass

Tables of a database depend on each other. For example, `tags` refers to rows of `notes`. If a pass reads `notes` before a commit of the owner and `tags` after it, the batch can have a tag of a note that the batch does not have. The tables then do not agree.

`@zukhruf/sqlite-snapshot` holds one moment with a read transaction. Each query of a `Snapshot` sees that moment, so the tables agree ([sqlite-snapshot ADR 0001](../../../snapshot/docs/adr/0001-never-immutable-and-held-only-while-reading.md)).

## Decision

A pass opens one `Snapshot`, reads `PRAGMA table_list` and each table in it, and disposes it. All events of a batch come from one moment.

- A pass reads the data version before it opens the snapshot. A commit between the two is in the snapshot. It also changes the data version, so the next poll makes one more pass, and that pass finds no change. A pass that finds no change gives no batch.
- A pass holds the snapshot only while it reads. It disposes the snapshot before it gives the batch to the host. The host applies the events with no read transaction open.
- The poll between two passes uses `DataVersion`, with its own connection and no read transaction ([sqlite-data-version ADR 0001](../../../data-version/docs/adr/0001-poll-data-version.md)).

## Considered Options

- **One snapshot for each table.** Each table holds a read transaction for a shorter time. The tables then come from different moments, and a batch can have a row that refers to a row that the batch does not have.
- **Read with no transaction.** Each statement sees the moment when it starts. Two tables can see two different moments.
- **Hold one snapshot for all passes.** The owner then cannot checkpoint its WAL, and the WAL grows with each commit.
- **One snapshot for each pass, held only while the pass reads.** This option was selected.

## Consequences

- The tables of a batch agree.
- A pass holds a read transaction for the time of a full read of the database. The checkpoint of the owner cannot go past it for that time.
- A pass that fails gives no batch, and the position does not change.
