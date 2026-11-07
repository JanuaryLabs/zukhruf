# A record and a key can hold a bigint

`@zukhruf/sqlite-changefeed` reads the rows of a SQLite database that another process owns. An `INTEGER` of SQLite holds 64 bits, and a JavaScript number holds an integer exactly only up to 2^53. Real databases keep larger integers: Chromium's history visits keep task ids such as 13399287446400972. Thus the changefeed reads each integer as a `bigint` ([its ADR 0008](../../../sqlite/changefeed/docs/adr/0008-every-integer-is-a-bigint.md)), and the differential must fingerprint it and keep it in a key. Before this change, the fingerprint threw for a `bigint`, because JSON cannot hold one, and `keyOf` threw in `JSON.stringify`.

The differential needs this with no host: a record of 64-bit integers is a record that it must diff with no loss. Thus the change passes the zero-consumer test.

## Decision

- `KeyValue` includes `bigint`.
- The canonical form of a `bigint` is its digits and `n`, for example `5n`. A JSON text has no `n` outside a string, so no JSON value has this form, and `5n` and `5` give different fingerprints. Bytes use `#` in the same way ([ADR 0006](./0006-a-record-and-a-key-can-hold-bytes.md)).
- The snapshot keeps a key value that is a `bigint` as `{"bigint": "<digits>"}`, and gives it back as a `bigint`. Bytes are `{"bytes": …}`, and no other key value is an object, so the two forms do not collide with a string key or with each other.

## Considered Options

- **A string for a `bigint`.** The string `"5"` and the integer `5n` then have one fingerprint and one key.
- **A number when it is safe.** The value then has two forms, and a value above 2^53 still has no form.
- **Digits and `n`, and an object in a key.** This option was selected.

## Consequences

- A record of 64-bit integers diffs with no loss.
- A source that gives an integer as a number keeps the fingerprints and keys that it had.
