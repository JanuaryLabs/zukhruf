# The package throws its own errors

Before this decision, the caller gave the error classes: `new Snapshot(path, unavailable)` and `requireColumns(columns, schema)`. The package then threw `new unavailable(path, cause)` or `new schema(path, missing)`. This design came from elt, commit 3a1c8293 ("each store's error classes are its typed port"). There, each store of elt gave its own classes to a shared adapter. It made that refactor easy. It was not a decision about this package.

Two rules disagree with it:

- Repository [ADR 0001](../../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md) says: a package exports the error class that its own API produces. Then a catch with `instanceof` works with the package that the caller imports. The other packages of zukhruf do this. This package and `@zukhruf/sqlite-data-version` were the only exceptions.
- The zero-consumer test: a package keeps only what it needs when no host exists. A SQLite reader with no host throws its own error. A parameter for the error class of a host does not pass this test.

## Decision

The package throws its own errors.

- `UnavailableError` (`src/unavailable-error.ts`): SQLite cannot open the file (`SQLITE_CANTOPEN`, 14). It has the `path`, and its `cause` is the error of SQLite.
- `MissingColumnsError` (`src/missing-columns-error.ts`): `requireColumns` finds missing columns. It has the `path`, and `missing` gives each missing column as `table.column`. `requireColumns` closes the snapshot before it throws.
- `new Snapshot(path)` and `requireColumns(columns)` take no error class.

A host that needs its own error translates the error of the package at its boundary. It keeps the error of the package as `cause`.

## Considered Options

- **The caller gives the error class.** This was the old design. It fails the zero-consumer test. Each call needs one more argument, and a catch with `instanceof` of a package class cannot work.
- **The caller gives a factory function.** It has the same problems as an error class, with a different type.
- **The package throws its own error classes.** This option was selected.

## Consequences

- A host that needs its own error class translates at its boundary, and keeps the error of the package as `cause`. The message of the host can name what the user must do, for example the access that the user must give.
- Each call has one parameter less.
- A catch with `instanceof UnavailableError` or `instanceof MissingColumnsError` works with the package that the caller imports.
- `UnavailableError` is the same knowledge as `UnavailableError` of `@zukhruf/sqlite-data-version`. It is the second place, so the class is a copy. [Code copied into this package](../copied-code.md) records it.
