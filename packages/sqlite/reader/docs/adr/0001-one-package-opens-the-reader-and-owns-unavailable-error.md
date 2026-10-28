# One package opens the reader and owns UnavailableError

`@zukhruf/sqlite-snapshot` and `@zukhruf/sqlite-data-version` each had a copy of two things. The first was `open(path)`: it opens a database read-only, and changes `SQLITE_CANTOPEN` (14) into `UnavailableError`. The second was the class `UnavailableError`, with `path` and a required `cause`. The copies were identical. The two packages are used without each other, so neither package imported the other. A ledger, `docs/copied-code.md` of each package, recorded the copies, and backlog item #3224 waited for a third place.

The planned `@zukhruf/sqlite-changefeed` is the third place. It uses a snapshot and a data version together, and it throws the same `UnavailableError`. Repository [ADR 0001](../../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md), rule 2, says that code moves into one home at the third place. A third copy of the class also breaks a catch: an `UnavailableError` of the changefeed is not an `instanceof` the class of the snapshot.

## Decision

`open` and `UnavailableError` move together into this package, because `open` throws `UnavailableError`. That is the dependency closure of the copies.

- `openReader(path)` is the old `open(path)`, with the same body. It now has an exported name, so the name says what it opens.
- `UnavailableError` is the same class, with the same message.
- `@zukhruf/sqlite-snapshot` and `@zukhruf/sqlite-data-version` depend on this package, and export its `UnavailableError` from their entry points. Repository ADR 0001, rule 6, allows this: a package exports the error class that its own API produces. `@zukhruf/fs` does the same for `NetworkDirectoryError`, which the mutex and the single flight export too.
- The copies and both ledgers are deleted.

The name is "reader", because the SQLite documentation calls a connection that reads a reader ("Write-Ahead Logging"). It is not a new word.

## Considered Options

- **Keep the copies, and add a third.** Rule 2 refuses it at the third place. Three classes also make three different `instanceof` checks.
- **The snapshot package owns them, and the data version imports the snapshot.** The two packages are used without each other. The data version would then depend on a package that it does not use.
- **Only `UnavailableError` moves.** `open` is the code that throws it, and the changefeed needs `open` too. A half move leaves two copies of `open`.
- **One package for `open` and `UnavailableError`.** This option was selected.

## Consequences

- An error of any of the packages is an `instanceof` the `UnavailableError` of each of them, because there is one class.
- A fix to the open or to the error is made in one place.
- The snapshot and the data version have one runtime dependency. It is a base package, so the layers do not change.
