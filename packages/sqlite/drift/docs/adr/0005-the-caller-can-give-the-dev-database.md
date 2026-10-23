# The caller can give the dev database

A declaration makes its objects in an empty database in memory ([ADR 0001](./0001-compare-the-text-that-sqlite-stores.md)). Atlas calls this database the dev database. Prisma calls it the shadow database. Before this decision, the package opened it with `new DatabaseSync(':memory:')`.

SQLite keeps three kinds of names on the connection, not in the database file:

- A virtual-table module, for example `vec0` of the sqlite-vec extension. `CREATE VIRTUAL TABLE … USING vec0(…)` fails with `no such module: vec0` in a connection that did not load the extension.
- A function of the application, which `DatabaseSync.function` registers. An index on an expression that calls it fails with `no such function` in a connection that did not register it.
- A collation that an extension adds.

A connection that the package opens has only what SQLite has by default. Thus a declaration that names one of these could not be made. The statements must run in a connection that has the same modules, functions and collations as the target database. Only the caller knows how to open such a connection.

Thus `new Declaration(statements, { rows, devDatabase })` takes `devDatabase`, a function that opens a new connection. The caller opens it as it opens the target database: it loads the same extensions and registers the same functions. When there is no `devDatabase`, the package opens `new DatabaseSync(':memory:')`. A caller that forgets the option gets the error of SQLite, for example `no such module: vec0`, and loses nothing.

A declared object is the first row that a statement adds ([ADR 0004](./0004-a-statement-owns-the-objects-its-create-makes.md)). Thus the dev database must be empty when the declaration starts. When it has an object, `new Declaration` fails. Atlas also refuses a dev database that is not clean. `new Declaration` closes the connection when it finishes, also when it fails.

## Considered Options

- **A list of extensions that the package loads.** It does not register functions or collations, and the package must then know how each extension loads.
- **A function that prepares the connection that the package opened.** `node:sqlite` loads an extension only when the connection was opened with `allowExtension: true`. The package cannot know which options the connection needs.
- **The target database itself, in a transaction that rolls back.** The target already has objects with the same names, so the statements fail there. A write also needs a write lock, and `drift` must work on a database opened read-only.
- **A function that opens the connection.** This option was selected. It is the dev database of Atlas and the shadow database of Prisma.

## Consequences

- A declaration can name a virtual table of an extension module, an index on a function of the application, or a column with a collation of an extension.
- The caller gives the same modules, functions and collations to the dev database and to the target database. When they are different, the text can be different, or the target fails with the error of SQLite.
- A dev database that has an object makes `new Declaration` fail.
- `new Declaration` closes the dev database. The caller does not use the connection after it gives it.
