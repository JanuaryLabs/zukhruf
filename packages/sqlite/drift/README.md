# @zukhruf/sqlite-drift

A package keeps tables, indexes, views and triggers in a SQLite database. A later version of the package can declare them otherwise, for example with one more column. The database still stores the objects as the earlier version made them, and the new code fails on them, for example with `no such column`. This package compares the stored objects with their declaration, and makes the database store them as declared. No person keeps a version number. This is also known as declarative schema management, and the difference that it finds is known as schema drift.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment. It uses only `node:sqlite`.

```sh
npm install @zukhruf/sqlite-drift
```

```ts
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Declaration } from '@zukhruf/sqlite-drift';

await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
using database = new DatabaseSync(join(scratch.path, 'app.sqlite'));
// An earlier version made the table without failed_at.
database.exec(`CREATE TABLE failures (directory TEXT PRIMARY KEY, error TEXT NOT NULL);
  INSERT INTO failures VALUES ('/data/notes', 'denied')`);

const failures = new Declaration([
  'CREATE TABLE failures (directory TEXT PRIMARY KEY, error TEXT NOT NULL, failed_at TEXT NOT NULL)',
]);
console.log(failures.drift(database));
failures.apply(database);
console.log(failures.drift(database));
console.log(database.prepare('SELECT count(*) AS rows FROM failures').get());
```

Output:

```
stale
fits
[Object: null prototype] { rows: 0 }
```

## A declaration compares the text that SQLite stores

- `new Declaration(statements)` makes the objects once in an empty database in memory, and keeps the text that SQLite stores for each one. [ADR 0001](./docs/adr/0001-compare-the-text-that-sqlite-stores.md) tells why.
- `drift(database)` gives `missing` when the database stores none of the objects, `fits` when it stores each one as declared, and `stale` for all other cases. It only reads, so it also works on a database opened read-only.
- Each change to a CREATE statement is drift: a column, a type, a CHECK, STRICT, the query of a view.
- A change of meaning with no change of text is not drift. When the meaning of a column changes, change its name too.
- SQLite takes names that are different only in ASCII case as one name.

## Apply makes the database store the declaration

- `apply(database)` does nothing when the drift is `fits`.
- When no stored object is stale, `apply` makes each missing object, and the other objects keep their rows.
- When one stored object is stale, `apply` replaces every object of the declaration, and their rows are gone. [ADR 0002](./docs/adr/0002-a-stale-object-replaces-the-whole-declaration.md) tells why.
- `apply` does not drop an object that the declaration does not name.
- In a transaction of the caller, `apply` works in a savepoint, and a rollback of the caller removes its changes. With no transaction, `apply` writes in its own `BEGIN IMMEDIATE` transaction.
- A caller that must keep the rows of a stale table asks `drift`, and changes the table itself.

## Write a declaration

- List a table before the tables that refer to it.
- A declaration must stand alone in an empty database. Do not declare a trigger or an index on a table that the declaration does not name, and do not use a function that only your connection registers.
- Give each table its own declaration when it must keep its rows while another table changes.

## Errors

| Error                    | When                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------- |
| The error of SQLite      | `new Declaration` fails when a statement does not run in an empty database.           |
| `database is locked`     | `apply` with no transaction waits for the busy timeout of the connection, then fails. |
| The error of a statement | `apply` fails, and the database stays as it was.                                      |

## The same concepts in other systems

| System                               | What it does                                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Röthlisberger's SQLite migrator      | It makes the declaration in memory and compares `sqlite_schema`. It changes a stale table with the 12 steps of SQLite and keeps the rows. |
| Airbyte destinations                 | Each sync compares the final table with the stream (`existingSchemaMatchesStreamConfig`), and a soft reset makes a stale table again.     |
| Drizzle Kit `push`, Prisma `db push` | They compare a declaration in TypeScript or in the Prisma language with the database, and change the database.                            |
| Android Room                         | It keeps a version number for migrations, and a hash of the declaration that finds a number that a person forgot to raise.                |
| Kubernetes controllers               | Each loop compares the desired state with the state that exists, and changes what is different.                                           |

## Documentation

- [0001 Compare the text that SQLite stores](./docs/adr/0001-compare-the-text-that-sqlite-stores.md)
- [0002 A stale object replaces the whole declaration](./docs/adr/0002-a-stale-object-replaces-the-whole-declaration.md)

## Development

This package is part of the [zukhruf](../../../README.md) workspace. Run the commands from the workspace root.

```sh
npm install
npx nx run sqlite-drift:test        # builds, then runs the tests in src/
npx nx run sqlite-drift:typecheck   # formats, lints, then type checks
npx nx run sqlite-drift:build       # compiles src/ to dist/
```

```
src/
  index.ts               the exports
  declaration.ts         Declaration and Drift
  declaration.test.ts    the tests, on real SQLite files
```
