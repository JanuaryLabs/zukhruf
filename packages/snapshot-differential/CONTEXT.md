# Snapshot differential

An upstream with no change log can give only a list of its records. A snapshot differential compares that list with the list of the last committed scan, and gives the changes. A record that is not in the list is not always deleted: a cache holds only part of its records, and an upstream with a time to live drops old records. A deletion policy judges each such key.

## Language

**Scan**:
One list of records from the upstream, which the differential compares with the snapshot.
_Avoid_: Read, pass, sync (an ELT pipeline uses these words for its own runs)

**Record**:
One item of a scan. Its key identifies it.
_Avoid_: Row (a row is in a destination), document

**Key**:
The JSON array of the primary key values of a record, in the order of the primary key fields. A key value is a string, a number, a `bigint`, a boolean, or bytes. The JSON holds bytes as `{"bytes": "<base64url>"}` and a `bigint` as `{"bigint": "<digits>"}`.
_Avoid_: ID (an ID is one primary key field)

**Fingerprint**:
The SHA-256 of the canonical form of a record: its JSON with sorted object keys, each bytes value as `#` and its base64url, and each `bigint` as its digits and `n`. Equal records have equal fingerprints. The caller can give its own fingerprint with the `fingerprint` option.
_Avoid_: Hash (a hash can be of anything), version

**Snapshot**:
The keys that the last committed scan saw, each with the fingerprint of its record. The keys that the policy judged unknown stay in it too. The caller saves the snapshot as the state of the diff.
_Avoid_: Cache (a cache is one kind of upstream), checkpoint (an ELT pipeline's word for all saved state)

**Grouped snapshot**:
The snapshot of a grouped scan, as three keyed collections: `groups`, each group's key with its fingerprint and the snapshot of its records; `unknown`, each key that belongs to no group; and `listed`, the listed groups. `SnapshotDifferential.noGroups` is the grouped snapshot before the first scan.
_Avoid_: Grouped state (the state change holds the grouped snapshot and its snapshot changes)

**Saved entry**:
One entry of a collection of a grouped snapshot under its key, as a store saves it: a group, an unknown key, or a listed group, which is saved as `true`. `savedGroups` reads the saved entries of each collection back into a grouped snapshot.
_Avoid_: Row (a row is in a destination), record (a record is an item of a scan)

**Holder**:
The group that held a key that waits in `unknown` for the last part's judgment. The unknown key keeps it, and the policy is told it.
_Avoid_: Owner, parent

**Change**:
What a diff yields: an insert, an update, a delete of a key, and the new snapshot last.
_Avoid_: Event, message (an ELT pipeline's word for what a source yields)

**Snapshot changes**:
What one grouped diff changed in each collection of the grouped snapshot since the snapshot it got: for each collection, the saved entries to put under their keys, and the keys to remove. A store that applies the snapshot changes of each diff in order has the saved entries of the new grouped snapshot.
_Avoid_: Delta, patch, diff (the diff is the comparison of a scan with the snapshot)

**Put**:
A saved entry of the snapshot changes that the store saves under its key, in place of the entry it has.
_Avoid_: Upsert (the word of a record in a destination), write

**Remove**:
A key of the snapshot changes whose saved entry the store deletes. A remove is of a saved entry, not of a record.
_Avoid_: Delete (a delete is the change of a record)

**Insert**:
The change for a record whose key the snapshot does not have.
_Avoid_: Create, add, upsert (an upsert does not tell an insert from an update)

**Update**:
The change for a record whose key the snapshot has with a different fingerprint. A key that the policy judged unknown is in the snapshot, so a changed record with that key is an update.
_Avoid_: Modify, upsert

**Saved fingerprint**:
The fingerprint that the snapshot has for the key of an update. An update gives it as `savedFingerprint`, with the new record.
_Avoid_: Old fingerprint, previous hash

**Delete**:
The change for a vanished key that the policy judged deleted. It gives the key as its primary key fields, and no record.
_Avoid_: Remove (a remove is of a saved entry), tombstone

**Bytes**:
A `Uint8Array` value, such as a `Buffer` or a `BLOB` of SQLite. A record and a key can hold bytes.
_Avoid_: Binary, blob (a blob is the SQLite type), buffer (a buffer is one kind of bytes)

**Vanished key**:
A key that the snapshot has and the scan does not list.
_Avoid_: Missing key, removed key, gone

**Group**:
The records that one input of a grouped scan produced, such as one page, under the group's key. A scan lists a group when it reads it, keeps it unread, or finds its fingerprint unchanged. A vanished key names the group that held it in the last committed scan.
_Avoid_: Partition, batch, bucket

**Deletion policy**:
The Strategy that judges each vanished key. It gives one verdict for each key.
_Avoid_: Filter, rule, covers

**Verdict**:
What a vanished key means: deleted, unknown, or expired.
_Avoid_: Status, result

**Deleted**:
The verdict when the upstream deleted the record. It is the closed-world assumption: what the scan does not list is false. The diff yields a delete, and the key leaves the snapshot.
_Avoid_: Removed

**Unknown**:
The verdict when the scan cannot tell. It is the open-world assumption: what the scan does not list can still be true. The key stays in the snapshot, and the policy judges it again at the next scan.
_Avoid_: Pending, skipped

**Expired**:
The verdict when the upstream dropped the record for good, with no deletion, as a time to live does. The key leaves the snapshot, and no delete is yielded.
_Avoid_: Forgotten, stale

**Expiry**:
The timestamp at which the upstream drops a record, as an ISO 8601 UTC string with milliseconds, such as `2026-01-01T00:00:00.000Z`. The `expiresBy` option names the record field that holds it, and the snapshot keeps it with the key, so the policy can read it from the vanished key.
_Avoid_: TTL (a time to live is a duration, not a timestamp), deadline

**Horizon**:
The timestamp from which the upstream keeps records. A record with an expiry before the horizon expired.
_Avoid_: Cutoff, window

**Coverage**:
The part of its records that the upstream holds and lists in a scan, such as the ranges of a conversation that a cache loaded.
_Avoid_: Scope (an ELT pipeline uses scope for what an import selects)

**Lookback window**:
The part of a scan that the next scan reads again, such as the days that an upstream can still restate. Only the records in it stay in the snapshot.
_Avoid_: Keeps, re-read range

**Part**:
One call of a diff that lists only part of a scan, because the upstream cannot list all its records in one call. The scan continues in the next call. Only the last part judges the vanished keys.
_Avoid_: Page (the upstream's unit), batch, pass (an ELT pipeline uses pass for its runs)

**Listed key**:
A key that an earlier part of the open scan listed. At the last part, a listed key is not a vanished key.
_Avoid_: Seen key, marked key

**Listed group**:
A group that an earlier part of the open grouped scan listed. Each part adds the groups that it lists, and the last part removes every listed group. At the last part, a listed group keeps its records, and the policy is told that the scan listed it.
_Avoid_: Seen group, marked group

**Group**:
The records that one input produced, such as one file, with a fingerprint of the input. A group with the same fingerprint as before keeps its records, and the diff does not read them.
_Avoid_: Batch, partition (an ELT pipeline uses partition for its own concept)

**Kept group**:
A group that the scan lists by its key only, because the source knows that its input did not change. The diff keeps its saved fingerprint and records, and does not read it.
_Avoid_: Skipped group, cached group, deferred group (deferred is the reason of one source, not the concept)

**Failed group**:
A group that the scan lists by its key only, because the source could not read its input, such as a page that answered 503. The diff keeps the saved fingerprint and records of the group, so its keys do not vanish, apart from a record that another group of the scan gives, which moved. When the snapshot does not have the group, the diff keeps nothing.
_Avoid_: Errored group, skipped group, retried group (a retry is what the source does next, not the concept)
