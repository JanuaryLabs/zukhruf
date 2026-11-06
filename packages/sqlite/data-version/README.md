# @zukhruf/sqlite-data-version

Some programs keep their data in a SQLite database, and write it while they run. Another program wants to know when the data changes, so that it reads again. A file-change event does not tell it: the owner keeps the file open and commits through a WAL, and the event comes only when the file closes. SQLite gives a number for this: `PRAGMA data_version`. It changes on each commit by another connection. This package keeps its own read-only connection to the database, and gives that number. Poll it, and read again when it changes. Some owners let no reader in, so `DataVersion.ofExclusiveOwner` observes the file stamp of the database file in its place.

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

import { DataVersion } from '@zukhruf/sqlite-data-version';
import { open } from '@zukhruf/sqlite-open';

await using scratch = await mkdtempDisposable(join(tmpdir(), 'data-version-'));
const path = join(scratch.path, 'notes.sqlite');

// The owner: another connection that writes the database through a WAL.
using owner = open(path);
owner.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT)`);

using version = new DataVersion(path);
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

- `new DataVersion(path)` opens its own read-only connection to the database. It does not share a connection with a reader. [ADR 0001](./docs/adr/0001-poll-data-version.md) tells why.
- `current` gives the data version now. It is the number of `DataVersion`, not the `PRAGMA data_version` of SQLite. Compare it with the value that you read before from the same `DataVersion`. A different value tells that another connection committed, or that the owner replaced the file. The same value tells that no change occurred.
- `DataVersion` is a `Gauge<number>` of `@zukhruf/async`. Give it to a `ChangeWatcher`, and each check reads `current`. A check after a commit of the owner gives `changed`, and a check with no commit gives `unchanged`.
- The number tells only that a change occurred. It does not count the commits, and it does not tell what changed.
- `DataVersion` follows the path. The owner can replace the file at the path: it can rename a new file over it, or delete the file and create it again. A replaced file is a change. Then `DataVersion` reads the new file, and each later commit to the new file is a change too. [ADR 0002](./docs/adr/0002-a-replaced-file-is-followed-by-name.md) tells why.
- A path that this process cannot see is no change. The path is missing, or the mode of a folder denies this process. The owner can delete the file and create it again a short time later. `DataVersion` keeps the old connection until it can see a file at the path again, and then a replaced file is a change.
- Each read of `current` reads the status of the file at the path one time (`stat`).
- A commit by the same connection does not change the number. The `DataVersion` connection never writes, so each commit that it sees comes from another connection.
- Dispose closes the connection. Use `using`, or call `[Symbol.dispose]()`.
- The package throws its own `UnavailableError`. It is the class of `@zukhruf/sqlite-open`, which opens the connection. The package exports it, so a catch with `instanceof` works with either package. A host that needs its own error translates the error of the package at its boundary, and keeps the error of the package as `cause`. [ADR 0003](./docs/adr/0003-the-package-throws-its-own-errors.md) tells why.

## Watch the data version

```ts
import { ChangeWatcher } from '@zukhruf/async';
import { DataVersion } from '@zukhruf/sqlite-data-version';

using version = new DataVersion(path);
// The data version is a local read: a check that takes the whole interval is stuck.
const watcher = new ChangeWatcher([version], {
  interval: 1_000,
  timeout: 1_000,
  clock: globalThis,
});
for await (const outcomes of watcher.watch(signal)) {
  const outcome = outcomes.get(version);
  if (outcome?.state === 'failed') throw outcome.error;
  if (outcome?.state === 'changed')
    console.log('The owner committed. Read again.');
}
```

## An owner that lets no reader in

An exclusive owner holds SQLite's exclusive locking mode, as Chromium holds its History. `new DataVersion(path)` then fails with `SQLITE_BUSY` (5). Observe the database with `DataVersion.ofExclusiveOwner(path)`:

```ts
import { DataVersion } from '@zukhruf/sqlite-data-version';

using version = DataVersion.ofExclusiveOwner(historyPath);
const seen = version.current;
// ... later
if (version.current !== seen) console.log('The owner committed. Read again.');
```

- It observes the file stamp of the database file (`@zukhruf/fs`). Each commit of the owner writes that file, so each commit is a change.
- A write to the journal alone is a transaction that the owner did not commit. It is no change.
- An open transaction that spills its pages into the database file is a change. A reader then reads the last commit again.
- A path that this process cannot see is no change, as for `new DataVersion`. When a file is at the path again, that is a change.
- It opens no connection, so it never waits for the lock of the owner.

[ADR 0004](./docs/adr/0004-the-version-of-an-exclusive-owner-is-the-stamp-of-its-database-file.md) tells why.

## The last write

The data version tells that the owner committed after you read it before. It does not tell when. A new process has no earlier value, so it cannot use the data version to find how old the data is.

`lastWrite(path)` gives the time when the owner last wrote the database. Use it when the owner writes only while it runs: a time in the past tells that the data has not changed since then.

```ts
import { lastWrite } from '@zukhruf/sqlite-data-version';

const written = lastWrite(path);
console.log(`The owner last wrote at ${written.toISOString()}`);
```

- The owner writes through the file and its WAL (`-wal`). The last write is the later of their modification times.
- The shared-memory index (`-shm`) does not count. A read-only reader writes it too, so its time can be later than the last write of the owner.
- The owner can remove the WAL when it closes. Then the last write is the time of the file.
- An empty WAL does not count. A reader that opens the database after the owner removed the WAL makes a new empty WAL, and that WAL has the time of the read. An empty WAL holds no data that the file does not hold.
- The function reads only the file system. It does not open the database.
- The macOS privacy controls do not stop it. They stop a process that has no access from reading the file, but not from reading the times of the file.

## Errors

| Error                        | When                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `UnavailableError`           | SQLite cannot open the file: `SQLITE_CANTOPEN` (14), for a missing file or a file that the system denies, a privacy denial too. `new DataVersion` throws it, and `current` throws it when it cannot open a replaced file. `cause` is the error of SQLite. `ofExclusiveOwner` throws it when the file is missing (`ENOENT`, `ENOTDIR`) or the system denies this process (`EACCES`, `EPERM`); then `cause` is the error of the file system. |
| The error of SQLite          | All other failures.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| The error of the file system | `current` cannot read the status of the path, for a cause other than a missing path or a folder that denies this process.                                                                                                                                                                                                                                                                                                                  |

`UnavailableError` has the `path`. `lastWrite` throws `UnavailableError` when the file is missing (`ENOENT`, `ENOTDIR`) or the system denies this process (`EACCES`, `EPERM`). Then `cause` is the error of the file system. `lastWrite` throws the error of the file system for all other failures.

## The same concepts in other systems

| System                                 | What it does                                                                                                                                                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite `PRAGMA data_version`           | It gives a number that changes when another connection commits. The SQLite documentation tells to use it to find out when to read again.                                                                                                                                    |
| File-change events (FSEvents, inotify) | They tell that a file changed. A process that keeps the file open and writes a WAL can commit many times before a write that an event reports.                                                                                                                              |
| Datasette `immutable` mode             | It opens a file that nobody writes, so the data never changes. This package is the opposite case: the owner writes the file.                                                                                                                                                |
| GNU `tail -F`                          | It follows a file by name. `tail.c` compares the device and inode of the name with the open file. When they differ, it prints "has been replaced; following new file" and opens the new file. `DataVersion` does the same.                                                  |
| SQLite `SQLITE_FCNTL_HAS_MOVED`        | `fileHasMoved` in `os_unix.c` compares the inode of the path with the inode of the open file. SQLite only gives a warning. It never opens the new file. `node:sqlite` has no `file_control`, so `DataVersion` reads the status of the path itself.                          |
| Filebeat native file identity          | It identifies a file by its device and inode. After a file closes, the system can give its inode to a new file, and Filebeat then sees no new file. `DataVersion` keeps the old file open until the new file is open, so the system cannot give that inode to the new file. |

## Documentation

- [0001 Poll data_version](./docs/adr/0001-poll-data-version.md)
- [0002 A replaced file is followed by name](./docs/adr/0002-a-replaced-file-is-followed-by-name.md)
- [0003 The package throws its own errors](./docs/adr/0003-the-package-throws-its-own-errors.md)
- [0004 The version of an exclusive owner is the stamp of its database file](./docs/adr/0004-the-version-of-an-exclusive-owner-is-the-stamp-of-its-database-file.md)

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
  data-version.ts         DataVersion
  followed-database.ts    the connection that follows the path to a replaced file
  stamped-database.ts     the file stamp of the database of an exclusive owner
  data-version.test.ts    the tests, on real SQLite files
  exclusive-owner.test.ts the tests, with an owner in another process
  last-write.ts           lastWrite
  last-write.test.ts      the tests, on real SQLite files
```
