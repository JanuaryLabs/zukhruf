# @zukhruf/sqlite-reader

Some programs keep their data in a SQLite database, and write it while they run. Another program can read that database. It opens a read-only connection, a reader. The open can fail because the file is missing, or because the system denies access to it. The caller can fix these failures, so the reader must name them. This package opens the reader, and throws `UnavailableError` for these failures.

`@zukhruf/sqlite-snapshot` and `@zukhruf/sqlite-data-version` open their connections with this package. Each of them exports the same `UnavailableError`, so a catch with `instanceof` works with the package that the caller imports.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment. It uses only `node:sqlite`.

```sh
npm install @zukhruf/sqlite-reader
```

```ts
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { UnavailableError, openReader } from '@zukhruf/sqlite-reader';

await using scratch = await mkdtempDisposable(join(tmpdir(), 'reader-'));
const path = join(scratch.path, 'notes.sqlite');

// The owner: another connection that writes the database through a WAL.
using owner = new DatabaseSync(path);
owner.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE notes (title TEXT);
  INSERT INTO notes VALUES ('first')`);

using reader = openReader(path);
console.log(reader.prepare('SELECT title FROM notes').all());

try {
  openReader(join(scratch.path, 'missing', 'notes.sqlite'));
} catch (error) {
  console.log(error instanceof UnavailableError);
}
```

Output:

```
[ [Object: null prototype] { title: 'first' } ]
true
```

## The rules

- `openReader(path)` gives a `DatabaseSync` of `node:sqlite`, opened with `readOnly: true`. The caller owns the connection, and closes it.
- The reader never writes. A write fails with the error of SQLite.
- The package throws its own `UnavailableError`. A host that needs its own error translates the error of the package at its boundary, and keeps the error of the package as `cause`.

## Errors

| Error               | When                                                                                                                                                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnavailableError`  | SQLite cannot open the file: `SQLITE_CANTOPEN` (14), for a missing file or a file that the system denies, a privacy denial too. `path` is the path. `cause` is the error of SQLite. |
| The error of SQLite | All other failures.                                                                                                                                                                 |

`UnavailableError` takes `(path, cause)`. Another package can throw it for the same failure from a different source. For example, `lastWrite` of `@zukhruf/sqlite-data-version` throws it when the file system cannot give the times of the file.

## The same concepts in other systems

| System              | What it does                                                                                                   |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| `sqlite3 -readonly` | It opens a database read-only. A missing file fails with "unable to open database file", the text of CANTOPEN. |
| Python `sqlite3`    | `sqlite3.connect('file:path?mode=ro', uri=True)` opens a database read-only, and raises `OperationalError`.    |

## Documentation

- [0001 One package opens the reader and owns UnavailableError](./docs/adr/0001-one-package-opens-the-reader-and-owns-unavailable-error.md)

## Development

This package is part of the [zukhruf](../../../README.md) workspace. Run the commands from the workspace root.

```sh
npm install
npx nx run sqlite-reader:test        # builds, then runs the tests in src/
npx nx run sqlite-reader:typecheck   # formats, lints, then type checks
npx nx run sqlite-reader:build       # compiles src/ to dist/
```

```
src/
  index.ts                the exports
  open-reader.ts          openReader
  unavailable-error.ts    UnavailableError
  open-reader.test.ts     the tests, on real SQLite files
```
