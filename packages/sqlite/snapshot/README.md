# @zukhruf/sqlite-snapshot

Some programs keep their data in a SQLite database, and write it while they run. Another program can read that database, but the reader must not see half of a change. For example, it must not read a row from one table before a commit and a row from another table after it. Also, the newest rows can be in the WAL file, not in the database file. This package opens such a database read-only, and holds one moment with a read transaction. Thus each query of the snapshot sees the same moment, and the tables agree. This is also known as snapshot isolation of a WAL reader.

Some owners let no reader in. Chromium holds its History with SQLite's exclusive locking mode, so a read fails with "database is locked". `Snapshot.ofExclusiveOwner` reads such a database from a checked copy at the last commit of the owner.

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

import { Snapshot, UnavailableError } from '@zukhruf/sqlite-snapshot';

await using scratch = await mkdtempDisposable(join(tmpdir(), 'snapshot-'));
const path = join(scratch.path, 'notes.sqlite');

// The owner: another connection that writes the database through a WAL.
using owner = new DatabaseSync(path);
owner.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT);
  INSERT INTO notes (title) VALUES ('first')`);

{
  using snapshot = new Snapshot(path);
  snapshot.requireColumns({ notes: ['id', 'title'] });
  owner.exec("INSERT INTO notes (title) VALUES ('second')");
  console.log(snapshot.all('SELECT title FROM notes'));
}

using next = new Snapshot(path);
console.log(next.missingColumns({ notes: ['title', 'body'] }));
console.log(next.all('SELECT count(*) AS notes FROM notes'));

try {
  new Snapshot(join(scratch.path, 'missing', 'notes.sqlite'));
} catch (error) {
  console.log(error instanceof UnavailableError);
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

- `new Snapshot(path)` opens the database read-only. It runs `BEGIN` and a first read at once, so the snapshot holds the moment when it opens, not the moment of the first query of the caller.
- The snapshot never opens the file with `immutable`. The owner keeps a persistent WAL, and the newest rows are in it. [ADR 0001](./docs/adr/0001-never-immutable-and-held-only-while-reading.md) tells why.
- Hold a snapshot only while you read. An open read transaction stops the checkpoint of the owner, and then the WAL of the owner grows. Dispose the snapshot with `using`, or call `[Symbol.dispose]()`.
- `all(sql, ...parameters)` gives all rows. `iterate(sql, ...parameters)` gives the rows one at a time, for a table that is too large to hold in memory.
- `requireColumns(columns)` checks the columns that the reader needs, as `{ table: [column, ...] }`. When one is missing, it disposes the snapshot and throws `MissingColumnsError`.
- `missingColumns(columns)` gives the missing columns as `table.column`, and keeps the snapshot open. A reader whose queries use different tables checks each query with it.
- The package throws its own errors: `UnavailableError` and `MissingColumnsError`. `UnavailableError` is the class of `@zukhruf/sqlite-reader`, which opens the connection. The package exports it, so a catch with `instanceof` works with either package. A host that needs its own error translates the error of the package at its boundary, and keeps the error of the package as `cause`. [ADR 0002](./docs/adr/0002-the-package-throws-its-own-errors.md) tells why.
- Dispose commits the read transaction and closes the connection. A second dispose does nothing.

## An owner that lets no reader in

An exclusive owner holds SQLite's exclusive locking mode. It takes the lock at its first write and keeps it until it closes the database. Chrome, Edge, Brave, Arc and Dia hold their History this way. `new Snapshot(path)` then fails with `SQLITE_BUSY` (5). Read the database with `Snapshot.ofExclusiveOwner(path)`:

```ts
import { DatabaseChangingError, Snapshot } from '@zukhruf/sqlite-snapshot';

try {
  using history = await Snapshot.ofExclusiveOwner(path);
  history.requireColumns({ urls: ['id', 'url', 'title'] });
  for (const row of history.iterate('SELECT id, url, title FROM urls'))
    console.log(row.url);
} catch (error) {
  if (!(error instanceof DatabaseChangingError)) throw error;
  console.log('The owner kept writing. Read it again later.');
}
```

- The snapshot reads an owner copy: a clone of the database and its rollback journal in a private folder. APFS and Btrfs clone a file with no time and no space. Other file systems copy the bytes.
- The file stamps of the database and the journal must be the same before and after the copy. When the owner wrote during the copy, the snapshot tries again at once, up to 5 times. Then it throws `DatabaseChangingError`.
- The snapshot opens the copy for writing one time, so that SQLite rolls back a hot journal in the copy. The snapshot holds the last commit of the owner, and no page of a transaction that the owner did not commit.
- The snapshot never writes a file of the owner. A journal that a dead owner left stays as it is.
- Dispose deletes the copy. Dispose the snapshot as soon as the read ends.
- `MissingColumnsError` and `UnavailableError` name the path of the owner, not the copy.

[ADR 0003](./docs/adr/0003-an-exclusive-owner-is-read-from-a-checked-copy.md) tells why.

## Errors

| Error                   | When                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnavailableError`      | SQLite cannot open the file: `SQLITE_CANTOPEN` (14), for a missing file or a file that the system denies, a privacy denial too. `path` is the path. `cause` is the error of SQLite. `ofExclusiveOwner` throws it when it cannot copy the file (`ENOENT`, `EACCES`, `EPERM`); then `cause` is the error of the file system. |
| `MissingColumnsError`   | `requireColumns` finds a missing column. `path` is the path, and `missing` gives each missing column as `table.column`. The snapshot is closed.                                                                                                                                                                            |
| `DatabaseChangingError` | `ofExclusiveOwner` found a write of the owner during each of 5 copies. `path` is the path, and `attempts` is the number of copies. No copy stays.                                                                                                                                                                          |
| The error of SQLite     | All other failures, for example a file that is not a database. The constructor closes the connection before it throws.                                                                                                                                                                                                     |

## The same concepts in other systems

| System                       | What it does                                                                                                                                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite WAL readers           | A read transaction sees the database as it was at its first read, also while a writer commits. An open read stops the checkpoint at its end mark. See "Write-Ahead Logging" in the SQLite documentation. |
| Datasette `immutable` mode   | It opens a file with `immutable=1`, for a file that nobody writes. SQLite then skips the locks and the WAL. This package is the opposite case: the owner writes the file.                                |
| `sqlite3 -readonly`          | It opens a database read-only. Each statement outside a transaction can see a different moment.                                                                                                          |
| Chromium `sql::Database`     | It opens each database with the exclusive locking mode, as `exclusive_locking_ = true` in `sql/database.h`. No other process can read the database while the browser runs.                               |
| yt-dlp `_open_database_copy` | It copies the cookie database of a running Chromium and reads the copy. It copies the database file only, with no check.                                                                                 |

## Documentation

- [0001 Never immutable, and held only while reading](./docs/adr/0001-never-immutable-and-held-only-while-reading.md)
- [0002 The package throws its own errors](./docs/adr/0002-the-package-throws-its-own-errors.md)
- [0003 An exclusive owner is read from a checked copy](./docs/adr/0003-an-exclusive-owner-is-read-from-a-checked-copy.md)

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
  index.ts                    the exports
  snapshot.ts                 Snapshot and SnapshotColumns
  owner-copy.ts               the checked copy of an exclusive owner
  missing-columns-error.ts    MissingColumnsError
  database-changing-error.ts  DatabaseChangingError
  snapshot.test.ts            the tests, on real SQLite files
  exclusive-owner.test.ts     the tests, with an owner in another process
```
