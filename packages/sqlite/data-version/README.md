# @zukhruf/sqlite-data-version

Some programs keep their data in a SQLite database, and write it while they run. Another program wants to know when the data changes, so that it reads again. A file-change event does not tell it: the owner keeps the file open and commits through a WAL, and the event comes only when the file closes. SQLite gives a number for this: `PRAGMA data_version`. It changes on each commit by another connection. This package keeps its own read-only connection to the database, and gives that number. Poll it, and read again when it changes.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment. It uses only `node:sqlite`.

```sh
npm install @zukhruf/sqlite-data-version
```

```ts
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { DataVersion } from '@zukhruf/sqlite-data-version';

class Unavailable extends Error {
  constructor(path: string, cause: unknown) {
    super(`Cannot read ${path}`, { cause });
  }
}

await using scratch = await mkdtempDisposable(join(tmpdir(), 'data-version-'));
const path = join(scratch.path, 'notes.sqlite');

// The owner: another connection that writes the database through a WAL.
using owner = new DatabaseSync(path);
owner.exec(`PRAGMA journal_mode = WAL;
  CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT)`);

using version = new DataVersion(path, Unavailable);
let seen = version.current;
for (const title of ['first', 'second']) {
  owner.prepare('INSERT INTO notes (title) VALUES (?)').run(title);
  const now = version.current;
  console.log(now !== seen ? `changed after ${title}` : 'no change');
  seen = now;
}
console.log(version.current === seen ? 'no change' : 'changed');
```

Output:

```
changed after first
changed after second
no change
```

## The rules

- `new DataVersion(path, unavailable)` opens its own read-only connection to the database. It does not share a connection with a reader. [ADR 0001](./docs/adr/0001-poll-data-version.md) tells why.
- `current` gives the data version now. Compare it with the value that you read before. A different value tells that another connection committed. The same value tells that no other connection committed.
- The number tells only that a change occurred. It does not count the commits, and it does not tell what changed.
- A commit by the same connection does not change the number. The `DataVersion` connection never writes, so each commit that it sees comes from another connection.
- Dispose closes the connection. Use `using`, or call `[Symbol.dispose]()`.
- The caller gives the error class. Thus the error names what the caller needs, for example the access that the user must give.

## The last write

The data version tells that the owner committed after you read it before. It does not tell when. A new process has no earlier value, so it cannot use the data version to find how old the data is.

`lastWrite(path, unavailable)` gives the time when the owner last wrote the database. Use it when the owner writes only while it runs: a time in the past tells that the data has not changed since then.

```ts
import { lastWrite } from '@zukhruf/sqlite-data-version';

const written = lastWrite(path, Unavailable);
console.log(`The owner last wrote at ${written.toISOString()}`);
```

- The owner writes through the file and its WAL (`-wal`). The last write is the later of their modification times.
- The shared-memory index (`-shm`) does not count. A read-only reader writes it too, so its time can be later than the last write of the owner.
- The owner can remove the WAL when it closes. Then the last write is the time of the file.
- The function reads only the file system. It does not open the database.
- The macOS privacy controls do not stop it. They stop a process that has no access from reading the file, but not from reading the times of the file.

## Errors

| Error                          | When                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `new unavailable(path, cause)` | SQLite cannot open the file: `SQLITE_CANTOPEN` (14), for a missing file or a file that the system denies, a privacy denial too. |
| The error of SQLite            | All other failures.                                                                                                             |

`lastWrite` gives `new unavailable(path, cause)` when the file is missing (`ENOENT`) or the mode of its folder denies this process (`EACCES`). It gives the error of the file system for all other failures.

## The same concepts in other systems

| System                                 | What it does                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite `PRAGMA data_version`           | It gives a number that changes when another connection commits. The SQLite documentation tells to use it to find out when to read again.       |
| File-change events (FSEvents, inotify) | They tell that a file changed. A process that keeps the file open and writes a WAL can commit many times before a write that an event reports. |
| Datasette `immutable` mode             | It opens a file that nobody writes, so the data never changes. This package is the opposite case: the owner writes the file.                   |

## Documentation

- [0001 Poll data_version](./docs/adr/0001-poll-data-version.md)
- [Code copied into this package](./docs/copied-code.md)

## Development

This package is part of the [zukhruf](../../../README.md) workspace. Run the commands from the workspace root.

```sh
npm install
npx nx run sqlite-data-version:test        # builds, then runs the tests in src/
npx nx run sqlite-data-version:typecheck   # formats, lints, then type checks
npx nx run sqlite-data-version:build       # compiles src/ to dist/
```

```
src/
  index.ts                the exports
  data-version.ts         DataVersion and UnavailableError
  data-version.test.ts    the tests, on real SQLite files
  last-write.ts           lastWrite
  last-write.test.ts      the tests, on real SQLite files
```
