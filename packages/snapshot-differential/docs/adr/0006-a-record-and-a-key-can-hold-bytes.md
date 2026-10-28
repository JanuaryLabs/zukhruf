# A record and a key can hold bytes

`@zukhruf/sqlite-changefeed` diffs the tables of SQLite databases. A `BLOB` column gives bytes, as a `Uint8Array` from `node:sqlite` or a `Buffer` from other drivers. The fingerprint was the SHA-256 of the canonical JSON of a record, and a record with a value that JSON cannot hold with no change failed. Bytes are such a value: `JSON.stringify` writes a `Uint8Array` as an object of indexes. A `BLOB` can also be a primary key, and the key of a record was the JSON array of its key values, which the caller wrote.

## Decision

A record can hold bytes at any depth. The canonical form writes bytes as `#` and their base64url with no padding. A JSON text has no `#` outside a string, so no JSON value has the canonical form of bytes. Thus a string or an array of numbers with the same content as the bytes gives a different fingerprint. The canonical form of each JSON value is the same as before, so a saved fingerprint stays valid.

The canonical form checks each value itself. It accepts `null`, a string, a boolean, a finite number that is not `-0`, bytes, an array with no holes, and a plain object with no symbol keys. Each other value fails, as before.

`KeyValue` gets `Uint8Array`. The `key` option gives the primary key values of a record, not their JSON, and the package writes the key:

- A string, a number and a boolean are in the JSON as before, so a saved key stays valid.
- Bytes are `{"bytes": "<base64url>"}`. No other key value is an object, so no string key has this form.
- When the diff gives a key back, in a delete or to the policy, it reads the bytes back as a `Uint8Array`.

## Considered Options

- **Bytes as an object in the fingerprint, as in the key.** A record can hold an object, so a record that holds `{"bytes": "AQI"}` would have the fingerprint of a record that holds the bytes. In a key, no value is an object, so the object form is safe there only.
- **Bytes as a base64 string.** A record that holds the same text as a string would have the same fingerprint, and a key would collide with a string key.
- **The caller writes the JSON of the key, with bytes in a form that the package documents.** Each caller then writes the same encoding again, and a mistake makes a different key for the same record.
- **The package writes the key from the key values.** This option was selected.

## Consequences

- The `key` option gives an array of values. A caller that gave `JSON.stringify([value])` now gives `[value]`.
- A `Buffer`, a `Uint8Array` and a view of a larger buffer with equal bytes give equal fingerprints and equal keys.
- Other typed arrays, such as `Uint16Array`, are not bytes and fail. Their bytes depend on the byte order of the machine.
- The snapshot holds a key of bytes in base64url, so it is a third larger than the bytes.
