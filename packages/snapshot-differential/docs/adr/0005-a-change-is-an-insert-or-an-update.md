# A change is an insert or an update

The diff yielded one change, `upsert`, for a new record and for a changed record. A destination that merges by key does not need more. A change feed does: `@zukhruf/sqlite-changefeed` gives each consumer an `insert` or an `update`, as Debezium gives `c` (create) or `u` (update). The diff already compares each key with the snapshot. It knew which of the two each record was, and it did not tell.

The snapshot differential of Labio and Garcia-Molina (VLDB 1996) gives inserts, updates and deletes.

## Decision

The diff yields `{ type: 'insert', record }` and `{ type: 'update', record }` in place of `{ type: 'upsert', record }`, in `diff` and in `diffGroups`:

- A record whose key the snapshot does not have is an insert.
- A record whose key the snapshot has, with a different fingerprint, is an update.

The snapshot decides, and nothing else. The snapshot keeps each key that the policy judged unknown (`diff` keeps it in `snapshot`, and `diffGroups` keeps it in `unknown`). Thus a key that comes back from unknown with a different fingerprint is an update. This is also correct for the destination: the diff yielded no delete for an unknown key, so the destination still has its row.

The package keeps no `upsert`. A consumer that merges by key handles `insert` and `update` in the same way.

## Considered Options

- **Keep `upsert`, and add a `previous` flag to it.** Each consumer then reads two fields to know one fact. The words of Labio and Garcia-Molina, and of each change feed, are insert and update.
- **Make a key that comes back from unknown an insert.** The destination still has the row of that key, so an insert can fail on a unique key. The diff also compared the record with the saved fingerprint, so it knows that the key is not new.
- **An insert and an update, decided by the snapshot.** This option was selected.

## Consequences

- Each consumer of the change type must handle `insert` and `update`. The ELT pipeline maps both to its record message.
- An insert means that the snapshot does not have the key. It does not mean that the destination does not have a row for it. A key that expired, or that left the snapshot outside a lookback window, gets an insert when it comes back, and the destination can still have its row. A destination that loads such a scan must merge by key.
