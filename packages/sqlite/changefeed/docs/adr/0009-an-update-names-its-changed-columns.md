# An update names its changed columns

ADR 0003 gave an `update` the full new row and no `before`, so a host did not know which columns changed. In a live run of Ambient in context-compiler on 2026-11-07, Messages changed only a state column of old bank SMS rows, most likely the read state. The model saw each row again as an `update` and gave a notification for each old SMS: 3 of its 5 notifications about the user's data.

## Decision

- An `update` has `changed`: the columns whose values changed, in the order of the table's columns. Its type is a non-empty tuple, `readonly [string, ...string[]]`, so an update that changed no column cannot exist.
- The position keeps one hash for each column of each row in place of one hash for each row: the first 8 bytes of the SHA-256 of the column's canonical value. A changed column goes unseen only with a chance of 2^-64.
- The position keeps the columns of each table. A new column, or a dropped one, is the change of each row of its table. A table whose columns changed is saved also when it has no rows.
- `@zukhruf/snapshot-differential` takes the fingerprint from its caller (`fingerprint`), and gives the saved fingerprint with each update (`savedFingerprint`). Both are additive.

Precedents:

- CockroachDB changefeeds have a `diff` option.
- A SQLite changeset holds only the changed columns of an update, with their old and new values.
- Debezium gives `before` and `after`.

## Considered Options

- **`before`, the full old row.** The position must then keep each row (ADR 0003).
- **No change.** A host cannot tell a change of a state column from a change of the content.
- **One hash for each column.** This option was selected.

## Consequences

- A host can tell a change of a state column from a change of the content.
- The position grows with the number of columns. A probe on the 3.3 million rows of Mail's `raw_messageHeaders` (7 columns): read only 5.2 s, one SHA-256 for each row 9.7 s, one for each column 15.9 s.
- A position of an older version has no columns. Stored data is disposable: delete the position file, and the next run makes a new one.
