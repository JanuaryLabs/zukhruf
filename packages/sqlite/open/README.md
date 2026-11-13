# @zukhruf/sqlite-open

Programs keep their data in SQLite databases. One program, the owner, writes a database. Other programs read it, sometimes while the owner runs. Each program opens its connection with `new DatabaseSync` of `node:sqlite`, and then does the same setup again: it selects the journal, sets how long to wait for the lock of another connection, and finds which errors mean "the file is missing, or the system denies access". This package does that setup in one function, `open`.

Some readers cannot write the folder of the database, for example an agent that runs `sqlite3 -readonly` in a sandbox. In a write-ahead log, such a reader cannot open the database after the owner closes it, because SQLite deletes the `-wal` and `-shm` files at the last close, and the reader cannot make them again. Persistent WAL keeps the two files. `node:sqlite` has no API to turn it on, so this package loads a small native library that does it.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

This project is an experiment. It uses `node:sqlite`, and one native library for persistent WAL.

```sh
npm install @zukhruf/sqlite-open
```

```ts
import { existsSync } from 'node:fs';
import { mkdtempDisposable } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PersistentWriteAheadLog,
  UnavailableError,
  open,
} from '@zukhruf/sqlite-open';

await using scratch = await mkdtempDisposable(join(tmpdir(), 'open-'));
const path = join(scratch.path, 'notes.sqlite');

{
  // The owner writes the database, and then closes it.
  using owner = open(path, { journal: new PersistentWriteAheadLog() });
  owner.exec(`CREATE TABLE notes (title TEXT);
    INSERT INTO notes VALUES ('first')`);
}

// The -shm file stays, so a reader that cannot write the folder can open the database.
console.log(existsSync(`${path}-shm`));

using reader = open(path, { readOnly: true });
console.log(reader.prepare('SELECT title FROM notes').all());
console.log(reader.prepare('PRAGMA journal_mode').get());

try {
  open(join(scratch.path, 'missing', 'notes.sqlite'), { readOnly: true });
} catch (error) {
  console.log(error instanceof UnavailableError);
}
```

Output:

```
true
[ [Object: null prototype] { title: 'first' } ]
[Object: null prototype] { journal_mode: 'wal' }
true
```

## The rules

- `open(path, options)` takes the options of `new DatabaseSync` of `node:sqlite`, except `open`, and gives a `DatabaseSync`. The caller owns the connection, and closes it.
- `readOnly: true` opens a reader. The package does no other step. A reader never writes to the database, and never changes its journal.
- Without `readOnly`, `open` opens the connection of an owner, and the `journal` option sets the journal. The default is `WriteAheadLog`. A reader cannot have a `journal` option. TypeScript refuses it.
- A database in memory (`:memory:`, `''`, or a `file::memory:` URI) has no file, so it gets no journal.
- The busy timeout is 5000 milliseconds, unless the caller gives `timeout`. With `timeout: 0`, a lock of another connection fails at once with `SQLITE_BUSY` (5).
- The owner opens with extension loading on, so that a journal can load the native library. After the journal step, extension loading is as the caller asked with `allowExtension`. The default is off.
- When the open or the journal step fails, `open` closes the connection and throws. An unavailable file throws `UnavailableError`: a `MissingError` when the file or a folder on its path is not there, a `DeniedError` when the system denies access. All other failures throw the error of SQLite.
- The package throws its own `UnavailableError`. A host that needs its own error translates the error of the package at its boundary, and keeps the error of the package as `cause`.

`open` replaces `new DatabaseSync` at the call site, with three differences:

- It has no `open` option. `open` always opens the connection, because the journal step needs an open file.
- The busy timeout is 5000 milliseconds when the caller gives no `timeout`. `node:sqlite` uses 0.
- An owner opens with extension loading on for the journal step. After that step, extension loading is as the caller asked.

## Journals

Each journal is a strategy object: the caller gives an instance, for example `open(path, { journal: new RollbackJournal() })`. A new journal is a class that implements `Journal`, with one method: `apply(database)`.

| Journal                   | What it does                                                                                                                                                        | Use it for                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `WriteAheadLog` (default) | `PRAGMA journal_mode = WAL`, `PRAGMA journal_size_limit = 67108864` (64 MiB) and `PRAGMA synchronous = NORMAL`. SQLite deletes `-wal` and `-shm` at the last close. | An owner whose readers can write the folder.                                                                  |
| `PersistentWriteAheadLog` | The same steps, after the native library turns on persistent WAL. `-wal` and `-shm` stay after the last close.                                                      | An owner whose readers cannot write the folder, for example agents that run `sqlite3 -readonly` in a sandbox. |
| `RollbackJournal`         | `PRAGMA journal_mode = DELETE`. The first access rolls back a hot journal.                                                                                          | A file that the owner builds and then renames or deletes. A copy that must lose a hot journal.                |
| `UnchangedJournal`        | Nothing.                                                                                                                                                            | An owner that sets its own journal, for example a lock file whose `PRAGMA` must wait for the lock.            |

The size limit keeps a write-ahead log small after a large commit. Without it, the `-wal` file of a 20 MB commit stays 20 MB.

`WriteAheadLog` and `PersistentWriteAheadLog` take an optional page size, for example `new WriteAheadLog({ pageSize: 32768 })`. SQLite sets the page size of a file only before its first write, and never in a write-ahead log. The write-ahead log step is that first write, so the journal sets the page size just before it. An existing file keeps its own page size.

A write-ahead log syncs the `-wal` file to the disk before each checkpoint, not at each commit (ADR 0007). A crash of the program loses no commit. A power loss or a crash of the operating system can roll back the commits after the last checkpoint. The database file stays consistent. An owner whose commits must survive a power loss gives `synchronous: 'full'`, for example `new WriteAheadLog({ synchronous: 'full' })`. SQLite then syncs at each commit. On Linux, a commit of one row is about 12 times slower with `'full'`.

## Errors

| Error               | When                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UnavailableError`  | The file is missing, or the system denies access to it: `SQLITE_CANTOPEN` (14) from the open, a privacy denial too, or `SQLITE_READONLY_DIRECTORY` (1544) from the journal step, when the folder denies the write of the journal. `path` is the path. `cause` is the error of SQLite. It is one of the two classes below when the system says which case it is. A case that the system does not decide is a plain `UnavailableError`, for example a file that SQLite cannot open but the file system can. `UnavailableError.from(path, error)` also accepts `ENOENT`, `ENOTDIR`, `EACCES` and `EPERM` from the file system. |
| `MissingError`      | An `UnavailableError`: the file, or a folder on its path, is not there. For `SQLITE_CANTOPEN` (14), a read-only open of the file system gave `ENOENT` or `ENOTDIR`. The caller can check the path, or make the database.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `DeniedError`       | An `UnavailableError`: the system denies this process access to the file, or to a folder on its path. For `SQLITE_CANTOPEN` (14), a read-only open of the file system gave `EACCES` or `EPERM`. `SQLITE_READONLY_DIRECTORY` (1544) is always a `DeniedError`. The caller can give the process access.                                                                                                                                                                                                                                                                                                                       |
| `Error`             | `PersistentWriteAheadLog` runs on a platform that has no native library. The message names the platform, and the platforms that have one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Error`             | SQLite did not change the journal to a write-ahead log. The message gives the journal that SQLite kept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| The error of SQLite | All other failures, for example a file that is not a database.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

## Platforms

The native library is in `lib/<platform>-<arch>/` of the package, for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64` (glibc and musl), `win32-x64` and `win32-arm64`. Only `PersistentWriteAheadLog` loads it, at its first open.

A bundler that bundles this package does not copy the `lib` folder. A bundle that uses `PersistentWriteAheadLog` keeps `@zukhruf/sqlite-open` external, and ships it in `node_modules`. An Electron app also unpacks `lib` from its `asar` archive.

## Why not a package from npm

| Candidate                | Why it does not do the job                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------- |
| `node:sqlite`            | It has no file control, so it cannot turn on persistent WAL. Its busy timeout is 0 by default. |
| `better-sqlite3`         | It has no file control. Issues #1029 and #1101 ask for persistent WAL. They are open.          |
| `@photostructure/sqlite` | A copy of the `node:sqlite` API. It has no file control.                                       |
| `libsql`                 | The `better-sqlite3` API. It has no file control.                                              |
| Bun's `bun:sqlite`       | `db.fileControl(SQLITE_FCNTL_PERSIST_WAL, 1)` turns it on, but only in Bun.                    |

## The same concepts in other systems

| System                | What it does                                                                                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Lix (a fork of Nix)   | `LocalStore::openDB` turns on persistent WAL after it sets WAL, so users without write permission can read the store (NixOS/nix#10300). |
| Apple's system SQLite | It keeps persistent WAL by default. Its `sqlite3` leaves `-wal` and `-shm` after it closes.                                             |
| `better-sqlite3`      | Its busy timeout is 5000 milliseconds by default.                                                                                       |
| Python `sqlite3`      | `sqlite3.connect(path, timeout=5.0)`: its busy timeout is 5 seconds by default.                                                         |
| Rails 8               | A SQLite database gets a write-ahead log, `journal_size_limit = 67108864` and `synchronous = NORMAL` by default.                        |
| `sqlite3 -readonly`   | It opens a reader. A missing file fails with "unable to open database file", the text of CANTOPEN.                                      |

## Documentation

- [0001 One package opens the reader and owns UnavailableError](./docs/adr/0001-one-package-opens-the-reader-and-owns-unavailable-error.md)
- [0002 One open for readers and owners](./docs/adr/0002-one-open-for-readers-and-owners.md)
- [0003 Persistent WAL through a native library](./docs/adr/0003-persistent-wal-through-a-native-library.md)
- [0004 The journal is a strategy](./docs/adr/0004-the-journal-is-a-strategy.md)
- [0005 One map of failures and a busy timeout of 5 seconds](./docs/adr/0005-one-map-of-failures-and-a-busy-timeout-of-5-seconds.md)
- [0006 Zig builds every native library in one Linux job](./docs/adr/0006-zig-builds-every-native-library-in-one-linux-job.md)
- [0007 A write-ahead log syncs at checkpoints](./docs/adr/0007-a-write-ahead-log-syncs-at-checkpoints.md)
- [0008 A missing file and a denied file are two classes](./docs/adr/0008-a-missing-file-and-a-denied-file-are-two-classes.md)

## Development

This package is part of the [zukhruf](../../../README.md) workspace. Run the commands from the workspace root. The `native` target needs `zig` 0.16.

```sh
npm install
npx nx run sqlite-open:test        # builds the native libraries and dist, then runs the tests in src/
npx nx run sqlite-open:typecheck   # formats, lints, then type checks
npx nx run sqlite-open:build       # builds lib/ with zig, then compiles src/ to dist/
```

```
src/
  index.ts                          the exports
  open.ts                           open
  journal.ts                        the Journal interface
  write-ahead-log.ts                WriteAheadLog
  persistent-write-ahead-log.ts     PersistentWriteAheadLog
  rollback-journal.ts               RollbackJournal
  unchanged-journal.ts              UnchangedJournal
  unavailable-error.ts              UnavailableError, MissingError, DeniedError
  open.test.ts                      the tests, on real SQLite files and processes
  native/
    persist_wal.c                   the native library
    sqlite3.h, sqlite3ext.h         the SQLite 3.54.0 headers
    build.ts                        builds lib/ for each platform with zig
lib/                                built by the native target, not in git
```
