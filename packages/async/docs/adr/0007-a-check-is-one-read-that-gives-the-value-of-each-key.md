# A check is one read that gives the value of each key

[ADR 0004](./0004-a-change-watcher-yields-each-check-with-the-keys-that-changed.md) gave `pollChanges` one read for each key, and read the keys one after the other, in the order of the map. Microsoft SQL Server, one of its consumers in elt, reads the values of many keys in one query: each change signal gives a value for each table of the database. With one read for each key, the source made the query in the read of the first stream, kept the result in a variable that the reads of the other streams shared, and relied on the order of the map to start a new check (elt `9dab6767`). That is shared mutable state between functions, and its correctness depends on the order of the calls (temporal coupling). Nothing but a comment kept the order (#3840).

## Decision

`pollChanges(read, { interval, signal, clock })` takes one read for each check. The read gives a map from each key to its value:

1. When the signal aborted before the first check, end, and do no read.
2. The first check calls the read at once, and yields all the keys that it gave.
3. Wait `interval` milliseconds after the consumer asks for the next check, as before.
4. Call the read again. A key changed when its value differs (`!==`) from the value of the previous check, or when only one of the two checks gave the key. Yield the set of the keys that changed. The set can be empty.
5. Go to step 3.

The read decides how it gets the values: one after the other, at the same time, or from one query. Everything that one check makes stays in that call of the read.

A key that only one of two checks gave changed. A table that was dropped since the previous check thus wakes its stream, and the read of the stream then reports the failure.

The rest of ADR 0004 stays true: a check that found no change yields an empty set, an abort ends the iteration with no error, the wait starts when the consumer asks, values compare with `===`, and an error from the read rejects the iteration.

## Considered Options

- **Keep one read for each key, and batch in the consumer.** The consumer must know where a check starts, and the old API told it only through the order of the map.
- **A per-check cache that the consumer keys by signal, as DataLoader does.** DataLoader batches the loads of one request, and the request gives its boundary. With one read for each key, a consumer has no boundary of a check. With one read for each check, the call of the read is that boundary, and no cache is necessary.
- **RxJS: a timer, a read, `pairwise` and a diff.** The same steps, but a push stream: the next check starts after a wait from the end of the read, not from when the consumer asks. A slow pass then gets checks that it did not ask for. It also takes its time from a scheduler, not from the clock of the caller ([ADR 0005](./0005-a-wait-runs-on-the-clock-that-the-caller-gives.md)).
- **Both forms, one read for each key and one read for each check.** One read for each key is a read for each check that calls each read. Two forms of one concept double the contract.
- **One read for each check.** This option was selected.

## Consequences

- A caller with one key gives `async () => new Map([['version', await version()]])`.
- A caller with many reads chooses their order. It can read them one after the other, as before, or at the same time.
- The change is incompatible with the earlier form. Each caller of `pollChanges` changes in the release that brings it.
