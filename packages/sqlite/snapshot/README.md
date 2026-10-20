# @zukhruf/sqlite-snapshot

Some programs keep their data in a SQLite database, and write it while they run. Another program can read that database, but the reader must not see half of a change. For example, it must not read a row from one table before a commit and a row from another table after it. Also, the newest rows can be in the WAL file, not in the database file. This package opens such a database read-only, and holds one moment with a read transaction. Thus each query of the snapshot sees the same moment, and the tables agree. This is also known as snapshot isolation of a WAL reader.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment. It uses only `node:sqlite`.

```sh
npm install @zukhruf/sqlite-snapshot
```

```ts
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Snapshot } from '@zukhruf/sqlite-snapshot';

class Unavailable extends Error {
  constructor(path: string, cause: unknown) {
    super(`Cannot read ${path}`, { cause });
  }
}

class MissingColumns extends Error {
  constructor(path: string, missing: readonly string[]) {
    super(`${path} has no ${missing.join(', ')}`);
  }
}

await using scratch = await mkdtempDisposable(join(tmpdir(), 'snapshot-'));
const path = join(scratch.path, 'notes.sqlite');

// The owner: another connection that writes the database through a WAL.
using owner = new DatabaseSync(path);
owner.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
  INSERT INTO notes (title) VALUES ('first')`);

{
  using snapshot = new Snapshot(path, Unavailable);
  snapshot.requireColumns({ notes: ['id', 'title'] }, MissingColumns);
  owner.exec("INSERT INTO notes (title) VALUES ('second')");
  console.log(snapshot.all('SELECT title FROM notes'));
}

using next = new Snapshot(path, Unavailable);
console.log(next.missingColumns({ notes: ['title', 'body'] }));
console.log(next.all('SELECT count(*) AS notes FROM notes'));

try {
  new Snapshot(join(scratch.path, 'missing', 'notes.sqlite'), Unavailable);
} catch (error) {
  console.log(error instanceof Unavailable);
}
```

Output:

```
[ [Object: null prototype] { title: 'first' } ]
[ 'notes.body' ]
[ [Object: null prototype] { notes: 2 } ]
true
```

## The rules

- `new Snapshot(path, unavailable)` opens the database read-only. It runs `BEGIN` and a first read at once, so the snapshot holds the moment when it opens, not the moment of the first query of the caller.
- The snapshot never opens the file with `immutable`. The owner keeps a persistent WAL, and the newest rows are in it. [ADR 0001](./docs/adr/0001-never-immutable-and-held-only-while-reading.md) tells why.
- Hold a snapshot only while you read. An open read transaction stops the checkpoint of the owner, and then the WAL of the owner grows. Dispose the snapshot with `using`, or call `[Symbol.dispose]()`.
- `all(sql, ...parameters)` gives all rows. `iterate(sql, ...parameters)` gives the rows one at a time, for a table that is too large to hold in memory.
- `requireColumns(columns, schema)` checks the columns that the reader needs, as `{ table: [column, ...] }`. When one is missing, it disposes the snapshot and throws `new schema(path, missing)`.
- `missingColumns(columns)` gives the missing columns as `table.column`, and keeps the snapshot open. A reader whose queries use different tables checks each query with it.
- The caller gives the error classes. Thus each error names what the caller needs, for example the access that the user must give.
- Dispose commits the read transaction and closes the connection. A second dispose does nothing.

## Errors

| Error                          | When                                                                                                                                                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `new unavailable(path, cause)` | SQLite cannot open the file: `SQLITE_CANTOPEN` (14), for a missing file or a file that the system denies. `SQLITE_AUTH` (23) also gives this error. The tests do not cover 23: SQLite gives it when an authorizer callback denies an action, and the connection has no authorizer when it opens. |
| `new schema(path, missing)`    | `requireColumns` finds a missing column. The snapshot is closed.                                                                                                                                                                                                                                 |
| The error of SQLite            | All other failures, for example a file that is not a database. The constructor closes the connection before it throws.                                                                                                                                                                           |

## The same concepts in other systems

| System                     | What it does                                                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite WAL readers         | A read transaction sees the database as it was at its first read, also while a writer commits. An open read stops the checkpoint at its end mark. See "Write-Ahead Logging" in the SQLite documentation. |
| Datasette `immutable` mode | It opens a file with `immutable=1`, for a file that nobody writes. SQLite then skips the locks and the WAL. This package is the opposite case: the owner writes the file.                                |
| `sqlite3 -readonly`        | It opens a database read-only. Each statement outside a transaction can see a different moment.                                                                                                          |

## Documentation

- [0001 Never immutable, and held only while reading](./docs/adr/0001-never-immutable-and-held-only-while-reading.md)
- [Code copied into this package](./docs/copied-code.md)

## Development

This package is part of the [zukhruf](../../../README.md) workspace. Run the commands from the workspace root.

```sh
npm install
npx nx run sqlite-snapshot:test        # builds, then runs the tests in src/
npx nx run sqlite-snapshot:typecheck   # formats, lints, then type checks
npx nx run sqlite-snapshot:build       # compiles src/ to dist/
```

```
src/
  index.ts            the exports
  snapshot.ts         Snapshot, SnapshotColumns, UnavailableError and SchemaError
  snapshot.test.ts    the tests, on real SQLite files
```
