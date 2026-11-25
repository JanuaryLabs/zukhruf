# A grouped diff gives what changed in each keyed collection

Status: Accepted 2026-11-25 (backlog #4468).

Decision-makers: the elt session that designed step 4 of #4468 ("2026-11-25 STEP 4 DESIGN"), from the evidence and the precedents below.

A grouped snapshot was one JSON value: `{ groups, unknown, listed, holders }`. Each diff gave the whole value in its state change, and the caller saved the whole value. Thus each save rewrote every group, also the groups that the diff did not read. This is write amplification: a store writes much more than the change, as an LSM tree writes a key again at each compaction.

A scan in parts made this worse ([ADR 0002](./0002-a-scan-can-be-listed-in-parts.md)). A part reads a few groups, but its state holds every group of the snapshot and the list of every group that the open scan listed. The elt web source diffs each page of a crawl as a group, and saves the state after each part. On a real checkpoint of the startup-credits crawl, one known URL took 583 bytes. A crawl of the about 160,000 listing pages of a marketplace thus wrote about 93 MB at each checkpoint, also when the part read only 10 pages (#4468). A serverless state store cannot hold a value of that size (Google Datastore takes at most 1 MiB for one entity), and SQLite and Postgres write the full value again at each save.

The differential knows what changed: it knows which groups it read, which group a record moved out of, which keys it judged, and which groups it listed.

## Decision

A grouped snapshot is three keyed collections, and the state change of `diffGroups` gives the new snapshot and what changed in each collection.

1. **Three keyed collections.** `GroupedSnapshot` is `{ groups, unknown, listed }`: a map from each group key to its saved group, a map from each unknown key to its saved entry, and the set of the listed groups. The holder of a key that waits for the last part's judgment ([ADR 0009](./0009-a-vanished-key-names-the-group-that-held-it.md)) is a field of its unknown entry, `{ saved, holder? }`. Thus a holder without an unknown key cannot be built.
2. **The state change gives `{ snapshot, changes }`.** `changes` has `KeyedChanges` (`{ put, remove }`) for each collection: the entries to save under their keys, and the keys to delete. A listed group is saved as `true`.
3. **A group that the diff did not change keeps its object.** A group with the same fingerprint, a kept group ([ADR 0004](./0004-a-scan-can-keep-a-group-without-reading-it.md)), a failed group ([ADR 0010](./0010-a-scan-keeps-a-group-that-it-failed-to-read.md)) and a group that an open scan has not reached keep the object of the snapshot, so `put` does not have them, unless a record moved out of them. A group that a record moved out of, also a failed group (ADR 0010, point 2), gets a new object without the record, and `put` has it. Its records stay sorted by key, as the records of a group that the diff read are, so equal scans save equal entries.
4. **`listed` changes once in each part.** Each part puts only the groups that it lists for the first time in the open scan. The last part removes every listed group. Thus a part writes about what it read, and the scan writes the listed groups once.
5. **The caller gives the snapshot.** `diffGroups(groups, snapshot, { continues })` takes a `GroupedSnapshot`, and `SnapshotDifferential.noGroups` for the first scan. A caller in one process gives the snapshot of the last state change. A caller that saved the entries gives them to `savedGroups`, which checks each entry as the old state check did, and keeps the snapshot object of each group without a copy. `savedGroups` also rejects a holder that names no group of the snapshot, because an open scan keeps every group until its last part. It accepts a listed group that `groups` does not have: a failed group that the snapshot does not have is listed and keeps nothing.
6. **A snapshot is immutable.** Two snapshots share each group that the diff did not change, and the changes share the objects of the snapshot. Thus `diffGroups` never changes the snapshot that it gets, and a caller must not change a snapshot, its collections, or the entries of its changes. `noGroups` is a getter that gives a new empty snapshot at each read, so a caller that breaks this rule changes no other caller's first scan.

The ungrouped `diff` does not change. Its state is one map of keys, which a scan in parts lists in full at each part anyway.

## Considered Options

- **Keep one value, and let the store compare the old and the new value.** The store then reads and compares the whole snapshot at each save. The write is smaller, but the work and the memory are not, and each store must write the same comparison.
- **The source keeps its own index of the groups that it read.** The source then keeps a second copy of what the snapshot has, as ADR 0004 and ADR 0010 rejected for fingerprints and keys.
- **Changes only, with no snapshot in the state change.** A caller in one process must then fold the changes itself before the next diff. The snapshot costs nothing: it holds the objects that the changes hold.
- **Three keyed collections and their changes.** This option was selected.

## Consequences

- The state of a grouped diff has a new shape, and `diffGroups` takes a `GroupedSnapshot` in place of `unknown`. Each caller changes. A caller saves the changes of each state change in order, after it applied the inserts, updates and deletes before them.
- A part that reads one group puts one group and lists one group. The last part removes each listed group: O(N) once for each scan, not for each part.
- The diff still builds the index of every saved key at each call, so a call takes CPU for the whole snapshot. It writes nothing for the groups that it did not change.
- `holders` is no longer a field of its own. The holder is in the unknown entry.

## Confirmation

- `src/snapshot-differential.test.ts`, written first: a part puts only the group that it read and lists only that group; a group with the same fingerprint and a kept group put no group; a record that moves out of a failed group or a group that a part has not reached puts that group without the record; a key that vanishes in a part waits in `unknown` with its holder, a later part does not put it again, and the last part deletes it and removes it; the last part removes every listed group and every group that the scan neither listed nor failed to read; a failed group puts no group, unless a record moved out of it, and is listed, also one that the snapshot does not have; folding the changes of each diff into maps and reading them with `savedGroups` gives the same next diff and the same snapshot as passing the snapshot along; `savedGroups` rejects each malformed entry, also a holder that names no group, and names the snapshot. Also: the first scan from `noGroups` puts every group with its records sorted, yields an insert for each record and lists nothing; a group that a record moves out of stays sorted; `noGroups` is new at each read; `diffGroups` does not change the snapshot it gets, through parts that move, fail, keep and judge; a group listed again by a later part puts nothing; a waiting key that a later part lists again leaves `unknown` and is not judged; a key judged unknown stays with no holder and no put, through a scan in parts and a rescan; a waiting key that the last part judges unknown loses its holder; a group with no fingerprint survives `savedGroups` and is read again. The 16 grouped tests from before take the new API with their claims.
- 33 mutants, each kept in memory with `mutate.mjs` of the write-test skill, each CAUGHT by the test of its claim, apart from one equivalent mutant: without the `typeof` check of a holder, `groups.has` still rejects a holder that is not a string. A `noGroups` that gives one shared object, a `diffGroups` that clears or edits the snapshot it gets, a group whose records are not sorted, and a `savedGroups` that rejects a `null` fingerprint are each CAUGHT. A `savedGroups` that copies each group's snapshot fails the heap test at 176 MB. The scan fits in 144 MB when the snapshot stays where the parsed row holds it.
- Precedents. Kafka Connect's `OffsetStorageWriter` flushes only the partitions written since the last flush (apache/kafka 80b0aa04, `OffsetStorageWriter.java` lines 144-145 and 172-197). Flink's `RocksIncrementalSnapshotStrategy` uploads only the SST files that are new since the last checkpoint (apache/flink 1e367509, lines 85-88 and 168-177). Airbyte's `StatePersistence` upserts one row for each stream (airbyte-platform 6c9c8234, lines 264-343).
