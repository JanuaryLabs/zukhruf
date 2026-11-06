# One map of failures and a busy timeout of 5 seconds

The callers of SQLite handled the failures of an open in different ways:

- "The file is missing, or the system denies access" had four encodings in zukhruf: error 14 with an exact match, error 14 with a mask, and two sets of file system codes, one with `EPERM` and one without it.
- Some callers tested `existsSync` before the open. The file can change between the test and the open.
- Comments in elt said that a privacy denial of macOS gives `SQLITE_AUTH` (23). A probe on 2026-11-06 opened the Mail store from a process with no Full Disk Access. The open gave `SQLITE_CANTOPEN` (14), for a reader and for an owner, and `stat` of the file worked.
- About 12 opens had a busy timeout of 0. Such an open fails at once while another connection holds a lock.

## Decision

- `UnavailableError.from(path, error)` gives an `UnavailableError` for `SQLITE_CANTOPEN` (14), for `SQLITE_READONLY_DIRECTORY` (1544), and for the file system codes `ENOENT`, `ENOTDIR`, `EACCES` and `EPERM`. The codes are exact. Probes gave exactly 14 for a missing file, a missing folder, a file with mode 000, a symlink loop and a privacy denial. An owner in a folder that it cannot write gave 1544. A reader that tries to write gave the plain `SQLITE_READONLY` (8), which is not unavailable. For each other error it gives `undefined`. `open` uses it for the open and for the journal step. The packages that read the file system (`@zukhruf/sqlite-snapshot`, `@zukhruf/sqlite-data-version`) use it too.
- A caller tries the open, and catches `UnavailableError`. It does not test the file first.
- The busy timeout is 5000 milliseconds when the caller gives no `timeout`. `better-sqlite3`, Python `sqlite3` and Rails use the same value. A caller that must not wait, such as a lock, gives `timeout: 0`.

## Considered Options

- **Map more codes, for example `SQLITE_BUSY` or `SQLITE_NOTADB`.** No caller can fix a busy database or a file that is not a database with a grant of access. They stay the errors of SQLite.
- **Keep a busy timeout of 0.** A reader then fails during each commit of an owner that has a rollback journal.
- **A longer default.** A wait in `node:sqlite` stops the event loop. Most waits are milliseconds long. A caller that can wait longer gives `timeout`.
- **One factory for the failures that the caller can fix, and a default of 5 seconds.** This option was selected.

## Consequences

- An error of the open is an `UnavailableError` or the error of SQLite, in each repository.
- A wait for a lock can stop the event loop for up to 5 seconds. A caller in a server that polls a database of a different program can give a shorter `timeout`.
