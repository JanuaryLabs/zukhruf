# The caller can give the fingerprint

The diff compared each record by the SHA-256 of its canonical form. An update gave the new record only, so a caller could not tell what changed. `@zukhruf/sqlite-changefeed` must name the changed columns of an update, with no copy of the old row ([its ADR 0009](../../../sqlite/changefeed/docs/adr/0009-an-update-names-its-changed-columns.md)).

A differential needs this with no host: a source can know a better fingerprint than the canonical hash, such as a version or an ETag of the upstream, or one hash for each field. Thus the change passes the zero-consumer test.

## Decision

- `SnapshotDifferentialOptions` has `fingerprint`, a function of a record to a string. The default is the SHA-256 of the record's canonical form, as before.
- An update has `savedFingerprint`: the fingerprint that the snapshot saved for the key. A caller compares it with the record's new fingerprint.

## Considered Options

- **The old record in the snapshot.** The snapshot then keeps each record, and grows with the data of the upstream.
- **A caller's fingerprint, and the saved fingerprint with each update.** This option was selected.

## Consequences

- Both are additive. A caller that gives no `fingerprint` diffs as before, and may ignore `savedFingerprint`.
- A caller's fingerprint decides what is a change. A fingerprint that leaves out a field makes a change of that field no change.
