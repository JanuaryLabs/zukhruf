# A missing file and a denied file are two classes

[ADR 0005](./0005-one-map-of-failures-and-a-busy-timeout-of-5-seconds.md) made one class, `UnavailableError`, for "the file is missing, or the system denies access". A caller does different things for the two cases. A missing file is a wrong path, or a database that nobody made yet: the caller can make it, or answer "nothing here". A denied file needs a grant of access from the user. With one class, a caller looked a second time to know which case it had: `FileLock.check` of `@zukhruf/fs` ran `existsSync` after the `UnavailableError`, and hosts did the same to select the text that they show.

The file system says which case it is: `ENOENT` and `ENOTDIR` mean missing, `EACCES` and `EPERM` mean denied. `UnavailableError.from` had this code and discarded it. SQLite does not say: it gives `SQLITE_CANTOPEN` (14) for both. A read-only open of the same path with `node:fs` gives the code that SQLite hides. Probes on 2026-11-13, on Node 26.13 with SQLite 3.54, on macOS:

| The path                                             | SQLite | `openSync(path, 'r')` |
| ---------------------------------------------------- | ------ | --------------------- |
| No file                                              | 14     | `ENOENT`              |
| A file in a folder that is not there                 | 14     | `ENOENT`              |
| A path below a file                                  | 14     | `ENOTDIR`             |
| A file with mode 000                                 | 14     | `EACCES`              |
| A path in a folder with mode 000, with a file or not | 14     | `EACCES`              |
| A file that a sandbox denies                         | 14     | `EPERM`               |
| A missing file in a folder that a sandbox denies     | 14     | `ENOENT`              |
| A symbolic link to itself                            | 14     | `ELOOP`               |
| An owner in a folder that it cannot write            | 1544   | Not asked             |

`stat` is the wrong second question: it succeeds on a file with mode 000 and on a file that a privacy rule denies (the probe of ADR 0005).

## Decision

- `UnavailableError` has two subclasses. `MissingError`: the file, or a folder on its path, is not there. `DeniedError`: the system keeps this process from the file, or from a folder on its path. Each has its own message, with what the caller can do. `path` and `cause` are as before.
- Each of the two is an `instanceof UnavailableError`, so a catch of `UnavailableError` does not change.
- `UnavailableError.from(path, error)` gives the class that the error names:
  - `ENOENT` or `ENOTDIR` of the file system is a `MissingError`. `EACCES` or `EPERM` is a `DeniedError`.
  - `SQLITE_READONLY_DIRECTORY` (1544) is a `DeniedError`: the folder denies the write of the journal.
  - For `SQLITE_CANTOPEN` (14), `from` opens the path read-only with `node:fs`, and closes it at once. The code of that open selects the class, by the same file system map. The `cause` stays the error of SQLite.
- A case that the second open cannot decide stays a plain `UnavailableError`:
  - The second open succeeds. The file changed between the two opens, or SQLite could not open a file beside it, for example a reader of a write-ahead log that cannot make the `-shm` file ([ADR 0003](./0003-persistent-wal-through-a-native-library.md)).
  - The second open fails with a different code, for example `ELOOP`.
  - The path starts with `file:`. SQLite reads it as a URI, and the file system reads it as a file name, so the second open would ask about a different file. A `URL` object is such a path too.
- The packages that export `UnavailableError` (`@zukhruf/sqlite-snapshot`, `@zukhruf/sqlite-data-version`, `@zukhruf/sqlite-changefeed`, `@zukhruf/sqlite-federation`) export the two subclasses too.
- `FileLock.check` of `@zukhruf/fs` answers `'missing'` for a `MissingError`, and no longer looks with `existsSync`.

## Considered Options

- **One class, as before.** Each caller that must know the case looks a second time, with its own question. `existsSync` is the wrong question for a path in a folder that the system denies: it answers "not there" for a file that is there.
- **A `reason` field on `UnavailableError`.** A caller then tests a string, and TypeScript cannot narrow a catch by it. A field also needs a third value for the case that cannot be decided, which has a meaning only together with the other two.
- **A `stat` of the path after `SQLITE_CANTOPEN`.** `stat` succeeds on a file with mode 000 and on a file that a privacy rule denies (the probe of ADR 0005), so it tells a missing file from a present one, not from a denied one. It answers a different question than the open.
- **Two subclasses, and a second open that asks the same question as the first.** This option was selected.

## Consequences

- A caller catches `MissingError` or `DeniedError` when it needs the case, and `UnavailableError` when it does not.
- A failed open of SQLite costs one more open of the file system. A successful open costs nothing more.
- The second open is a second look, so the file can change between the two opens. The result is then a plain `UnavailableError`, or the class of the newer state. A caller that needs only one of the two classes must also handle the plain `UnavailableError`.
- A path in a folder that the system denies is a `DeniedError`, with a file there or not. The system does not say which.
- `FileLock.check` now throws for a lock file in a folder with mode 000, and for a symbolic link to itself. Before, `existsSync` answered "not there" for both, and the result was `'missing'`.
