# Every integer is a bigint

An `INTEGER` of SQLite holds 64 bits. A JavaScript number holds an integer exactly only up to 2^53 (`Number.MAX_SAFE_INTEGER`). By default, `node:sqlite` gives each integer as a number, and it throws `ERR_OUT_OF_RANGE` for an integer above 2^53. A pass then fails, and the feed gives no batch.

Real owners keep such integers. On 2026-11-07, 5 of the 21 imports of context-compiler had them: the history visits of Arc (100,715 rows, for example the task id 13399287446400972), Dia, Chrome and Edge, and the certificate serials of WhatsApp business names (#3934). Ambient could not read these imports.

## Decision

A pass reads the rows of each table with `readBigInts`. Each integer of a row and of a key is a `bigint`, also each `rowid`. The reads of the schema (`pragma_table_info`, `pragma_index_list`) still give numbers, because the feed compares them with numbers.

`@zukhruf/snapshot-differential` fingerprints a `bigint` and keeps it in a key. `@zukhruf/sqlite-snapshot` gives a statement with its own options (`Snapshot.prepare`).

Other drivers give one type for each type of the database:

- better-sqlite3 gives each integer as a `bigint` with `safeIntegers`.
- node-postgres gives each `int8` as a string.

## Considered Options

- **A number, as before.** A pass fails on a real import.
- **A number when it is safe, and a `bigint` above 2^53**, as mysql2 does with `supportBigNumbers` (with a string). The type of a column then changes from row to row. A consumer that adds two values of one column (`1n + 1`) fails only on rare rows, and no test with small values shows it.
- **A string above 2^53.** It is the same as the text of an `INTEGER`, so the host cannot tell an integer from a `TEXT` value.
- **Each integer a `bigint`.** This option was selected.

## Consequences

- A host gets a `bigint` for each integer. `JSON.stringify` throws for a `bigint`, so a host that writes JSON converts it, for example to a string.
- Each test of a host with integers runs the `bigint` path. A host does not see it for the first time on rare data.
- `5n` and `5` are different values in a key and in a fingerprint.
