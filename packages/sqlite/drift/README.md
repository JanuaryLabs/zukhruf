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

const failures = new Declaration(
  [
    'CREATE TABLE failures (directory TEXT PRIMARY KEY, error TEXT NOT NULL, failed_at TEXT NOT NULL)',
  ],
  { rows: 'replace' },
);
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

- `new Declaration(statements, { rows })` makes the objects once in an empty database in memory, and keeps the text that SQLite stores for each one. [ADR 0001](./docs/adr/0001-compare-the-text-that-sqlite-stores.md) tells why.
- `rows` is `'replace'` or `'keep'`. It tells `apply` what to do with the rows of a stale table. It has no default, so no caller loses rows because it forgot an option.
- `drift(database)` gives `missing` when the database stores none of the objects, `fits` when it stores each one as declared, and `stale` for all other cases. It only reads, so it also works on a database opened read-only.
- Each change to a CREATE statement is drift: a column, a type, a CHECK, STRICT, the query of a view.
- A change of meaning with no change of text is not drift. When the meaning of a column changes, change its name too.
- SQLite takes names that are different only in ASCII case as one name.

## Apply makes the database store the declaration

- `apply(database)` does nothing when the drift is `fits`.
- When no stored object is stale, `apply` makes each missing object, and the other objects keep their rows.
- With `rows: 'replace'`, when one stored object is stale, `apply` replaces every object of the declaration, and their rows are gone. [ADR 0002](./docs/adr/0002-a-stale-object-replaces-the-whole-declaration.md) tells why.
- With `rows: 'keep'`, `apply` rebuilds each stale table and keeps its rows. See [Keep the rows](#keep-the-rows).
- `apply` does not drop an object that the declaration does not name.
- In a transaction of the caller, `apply` works in a savepoint, and a rollback of the caller removes its changes. With no transaction, `apply` writes in its own `BEGIN IMMEDIATE` transaction. [`@zukhruf/sqlite-transaction`](../transaction) does this work, so when SQLite ends the transaction itself, `apply` throws the original error.

## Keep the rows

With `rows: 'keep'`, `apply` keeps the rows of each stale table. It replaces a stale index, trigger or view, because these have no rows. It rebuilds each stale table, in the order of the declaration:

1. It renames the stored table to a temporary name, with `PRAGMA legacy_alter_table` on. Thus the references of other tables, views and triggers stay on the name of the table.
2. It makes the table from its declared text, so SQLite stores the declared text.
3. It copies the columns that both tables have, by name. SQLite takes names that are different only in ASCII case as one name.
4. It drops the old table, and makes again the indexes and triggers on the table that the declaration does not name.
5. It runs `PRAGMA foreign_key_check`. When a kept row breaks a foreign key, `apply` fails.

[ADR 0003](./docs/adr/0003-keep-rows-rebuilds-a-table-and-keeps-its-references.md) tells why.

```ts
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Declaration } from '@zukhruf/sqlite-drift';

await using scratch = await mkdtempDisposable(join(tmpdir(), 'drift-'));
using database = new DatabaseSync(join(scratch.path, 'app.sqlite'));
// An earlier version made runs without status. Cases refer to runs.
database.exec(`CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE cases (run INTEGER NOT NULL REFERENCES runs (id) ON DELETE CASCADE);
  INSERT INTO runs VALUES (1, 'nightly');
  INSERT INTO cases VALUES (1)`);

const runs = new Declaration(
  [
    "CREATE TABLE runs (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'done')",
  ],
  { rows: 'keep' },
);
console.log(runs.drift(database));
runs.apply(database);
console.log(runs.drift(database));
console.log(database.prepare('SELECT * FROM runs').all());
console.log(database.prepare('SELECT count(*) AS cases FROM cases').get());
```

Output:

```
stale
fits
[ [Object: null prototype] { id: 1, name: 'nightly', status: 'done' } ]
[Object: null prototype] { cases: 1 }
```

- A column that only the declaration has gets its default.
- A column that only the stored table has is discarded, with its values.
- `apply` does not find a renamed column. A new name reads as one column dropped and one column added, so the values of the old column are discarded. To keep them, copy them yourself before `apply`.
- `apply` does not fill values and does not remove rows. When a stored row does not fit the declaration (NOT NULL, CHECK, a foreign key, STRICT), `apply` fails with the error of SQLite, and the table and its rows stay as they were. To keep such rows, change them with your own SQL before `apply`.
- When foreign keys are on and a table refers to a stale table (also the stale table to itself), `apply` must turn foreign keys off. SQLite ignores `PRAGMA foreign_keys` in a transaction. Thus `apply` turns foreign keys off before its own transaction, and on again after it. In a transaction of the caller, `apply` fails before it changes the database. Call `apply` outside a transaction, or turn foreign keys off before it.
- When no table refers to the stale table, `apply` also works in a transaction of the caller, with foreign keys on.
- After a rebuild, `PRAGMA legacy_alter_table` has its old value again, also when `apply` fails.

## Write a declaration

- List a table before the tables that refer to it.
- A declaration must stand alone in an empty database. Do not declare a trigger or an index on a table that the declaration does not name, and do not use a function that only your connection registers.
- With `rows: 'replace'`, give each table its own declaration when it must keep its rows while another table changes.

## Errors

| Error                                                                               | When                                                                                                                              |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| The error of SQLite                                                                 | `new Declaration` fails when a statement does not run in an empty database.                                                       |
| `database is locked`                                                                | `apply` with no transaction waits for the busy timeout of the connection, then fails.                                             |
| The error of a statement                                                            | `apply` fails, and the database stays as it was.                                                                                  |
| `Keeping the rows of a table that other tables reference needs foreign keys off, …` | `rows: 'keep'`, in a transaction of the caller, with foreign keys on, and another table refers to a stale table. Nothing changes. |
| The error of SQLite, for example `NOT NULL constraint failed: runs.name`            | `rows: 'keep'`, and a stored row does not fit the declared table. The table and its rows stay as they were.                       |
| `The kept rows break a foreign key: …`                                              | `rows: 'keep'`, and `PRAGMA foreign_key_check` finds a kept row that refers to no row. The database stays as it was.              |

## The same concepts in other systems

| System                               | What it does                                                                                                                                                                                                                                                          |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Röthlisberger's SQLite migrator      | It makes the declaration in memory and compares `sqlite_schema`. It changes a stale table with the 12 steps of SQLite and keeps the rows.                                                                                                                             |
| SQLite's 12 steps                    | "Making Other Kinds Of Table Schema Changes" in [the ALTER TABLE page](https://www.sqlite.org/lang_altertable.html): make a new table, copy the rows, drop the old table, rename the new one. `rows: 'keep'` renames the old table first instead. ADR 0003 tells why. |
| sqlite-utils `table.transform()`     | It rebuilds a table with the 12 steps and keeps the rows. A caller gives a map of renamed columns. `rows: 'keep'` has no such map.                                                                                                                                    |
| Airbyte destinations                 | Each sync compares the final table with the stream (`existingSchemaMatchesStreamConfig`), and a soft reset makes a stale table again.                                                                                                                                 |
| Drizzle Kit `push`, Prisma `db push` | They compare a declaration in TypeScript or in the Prisma language with the database, and change the database.                                                                                                                                                        |
| Android Room                         | It keeps a version number for migrations, and a hash of the declaration that finds a number that a person forgot to raise.                                                                                                                                            |
| Kubernetes controllers               | Each loop compares the desired state with the state that exists, and changes what is different.                                                                                                                                                                       |

## Documentation

- [0001 Compare the text that SQLite stores](./docs/adr/0001-compare-the-text-that-sqlite-stores.md)
- [0002 A stale object replaces the whole declaration](./docs/adr/0002-a-stale-object-replaces-the-whole-declaration.md)
- [0003 Keep rows rebuilds a table and keeps its references](./docs/adr/0003-keep-rows-rebuilds-a-table-and-keeps-its-references.md)

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
