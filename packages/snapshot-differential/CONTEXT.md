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
The JSON array of the primary key values of a record, in the order of the primary key fields. A key value is a string, a number, a boolean, or bytes. The JSON holds bytes as `{"bytes": "<base64url>"}`.
_Avoid_: ID (an ID is one primary key field)

**Fingerprint**:
The SHA-256 of the canonical form of a record: its JSON with sorted object keys, and each bytes value as `#` and its base64url. Equal records have equal fingerprints.
_Avoid_: Hash (a hash can be of anything), version

**Snapshot**:
The keys that the last committed scan saw, each with the fingerprint of its record. The keys that the policy judged unknown stay in it too. The caller saves the snapshot as the state of the diff.
_Avoid_: Cache (a cache is one kind of upstream), checkpoint (an ELT pipeline's word for all saved state)

**Change**:
What a diff yields: an insert, an update, a delete of a key, and the new snapshot last.
_Avoid_: Event, message (an ELT pipeline's word for what a source yields)

**Insert**:
The change for a record whose key the snapshot does not have.
_Avoid_: Create, add, upsert (an upsert does not tell an insert from an update)

**Update**:
The change for a record whose key the snapshot has with a different fingerprint. A key that the policy judged unknown is in the snapshot, so a changed record with that key is an update.
_Avoid_: Modify, upsert

**Bytes**:
A `Uint8Array` value, such as a `Buffer` or a `BLOB` of SQLite. A record and a key can hold bytes.
_Avoid_: Binary, blob (a blob is the SQLite type), buffer (a buffer is one kind of bytes)

**Vanished key**:
A key that the snapshot has and the scan does not list.
_Avoid_: Missing key, removed key, gone

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

**Group**:
The records that one input produced, such as one file, with a fingerprint of the input. A group with the same fingerprint as before keeps its records, and the diff does not read them.
_Avoid_: Batch, partition (an ELT pipeline uses partition for its own concept)

**Kept group**:
A group that the scan lists by its key only, because the source knows that its input did not change. The diff keeps its saved fingerprint and records, and does not read it.
_Avoid_: Skipped group, cached group, deferred group (deferred is the reason of one source, not the concept)
