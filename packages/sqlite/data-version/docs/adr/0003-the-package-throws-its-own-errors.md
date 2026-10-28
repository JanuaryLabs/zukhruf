# The package throws its own errors

Before this decision, the caller gave the error class: `new DataVersion(path, unavailable)` and `lastWrite(path, unavailable)`. The package then threw `new unavailable(path, cause)`. This design came from elt, commit 3a1c8293 ("each store's error classes are its typed port"). There, each store of elt gave its own classes to a shared adapter. It made that refactor easy. It was not a decision about this package.

Two rules disagree with it:

- Repository [ADR 0001](../../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md) says: a package exports the error class that its own API produces. Then a catch with `instanceof` works with the package that the caller imports. The other packages of zukhruf do this. This package and `@zukhruf/sqlite-snapshot` were the only exceptions.
- The zero-consumer test: a package keeps only what it needs when no host exists. A SQLite reader with no host throws its own error. A parameter for the error class of a host does not pass this test.

## Decision

The package throws its own `UnavailableError` (of `@zukhruf/sqlite-reader` since #3224, before that `src/unavailable-error.ts`). It has the `path`.

- `new DataVersion(path)` throws it when SQLite cannot open the file (`SQLITE_CANTOPEN`, 14). Its `cause` is the error of SQLite.
- `current` throws it when the path names a replaced file and SQLite cannot open that file ([ADR 0002](./0002-a-replaced-file-is-followed-by-name.md)).
- `lastWrite(path)` throws it when the file is missing (`ENOENT`) or the mode of its folder denies this process (`EACCES`). Its `cause` is the error of the file system.
- `new DataVersion(path)` and `lastWrite(path)` take no error class.

A host that needs its own error translates the error of the package at its boundary. It keeps the error of the package as `cause`. A host that gives a `DataVersion` to its own code translates `current` too.

## Considered Options

- **The caller gives the error class.** This was the old design. It fails the zero-consumer test. Each call needs one more argument, and a catch with `instanceof` of a package class cannot work.
- **The caller gives a factory function.** It has the same problems as an error class, with a different type.
- **The package throws its own error class.** This option was selected.

## Consequences

- A host that needs its own error class translates at its boundary, and keeps the error of the package as `cause`. The message of the host can name what the user must do, for example the access that the user must give.
- Each call has one parameter less.
- A catch with `instanceof UnavailableError` works with the package that the caller imports.
- `UnavailableError` is the same knowledge as `UnavailableError` of `@zukhruf/sqlite-snapshot`. It was the second place, so the class was a copy. At the third place, the class and the open that throws it moved into `@zukhruf/sqlite-reader` ([sqlite-reader ADR 0001](../../../reader/docs/adr/0001-one-package-opens-the-reader-and-owns-unavailable-error.md)). This package exports that class.
