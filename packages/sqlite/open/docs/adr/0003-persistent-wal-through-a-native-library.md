# Persistent WAL through a native library

An owner writes a database, and agents read it with `/usr/bin/sqlite3 -readonly` in the Codex sandbox. The sandbox does not let a reader write the folder of the database. A reader of a write-ahead log needs the `-shm` file. When no connection is open, SQLite has deleted the `-wal` and `-shm` files, and the reader must make them again. A reader that cannot write the folder cannot do this.

Probes on 2026-11-06, on a write-ahead log that `node:sqlite` wrote and closed:

| Reader                                   | Result                              |
| ---------------------------------------- | ----------------------------------- |
| `sqlite3 -readonly` in the Codex sandbox | `unable to open database file` (14) |
| `sqlite3 -readonly` outside the sandbox  | `unable to open database file` (14) |
| `node:sqlite` `readOnly` in the sandbox  | `unable to open database file` (14) |
| Each reader while the owner is open      | Reads                               |

For this reason the owners kept the rollback journal. But a rollback journal stops the commits of the owner while a reader reads, and `@zukhruf/sqlite-changefeed` refuses it ([its ADR 0002](../../../changefeed/docs/adr/0002-wal-is-required.md)).

SQLite has a setting for this case. `sqlite3.h` says of `SQLITE_FCNTL_PERSIST_WAL`: "Persisting the files is useful when other processes that do not have write permission on the directory containing the database file want to read the database file". Lix sets it in `LocalStore::openDB` for the same reason (NixOS/nix#10300). Apple's system SQLite sets it by default.

Only `sqlite3_file_control()` sets it. `node:sqlite` 26.13 has no file control. No package on npm sets it: see "Why not a package from npm" in the [README](../../README.md).

## Decision

- A native library, `persist_wal`, is a loadable SQLite extension of one function. Its entry point calls `file_control(db, "main", SQLITE_FCNTL_PERSIST_WAL, &on)` through the API table that SQLite gives to an extension.
- `PersistentWriteAheadLog` loads the library into the connection of the owner, and then sets the write-ahead log. Probes on macOS and in Linux containers: after the last close, `-wal` and `-shm` stay, and a reader that cannot write the folder reads each commit.
- SQLite makes the name of the entry point from the file name, so each platform keeps the file name `persist_wal` in its own folder.
- Only `PersistentWriteAheadLog` uses the library. The default journal does not, so a program that does not need persistent WAL loads no native code ([ADR 0004](./0004-the-journal-is-a-strategy.md)).
- After the load, `open` turns extension loading off again, unless the caller asked for it with `allowExtension`.

## Considered Options

- **Keep the rollback journal.** Commits wait for readers, and the changefeed cannot read the database.
- **A write-ahead log with no persistence.** Agents in the sandbox fail between two passes of the owner.
- **Readers open the file with `immutable=1`.** SQLite then skips the locks and the `-wal` file. While the owner writes, the reader can see half of a commit.
- **Keep a connection open at all times, so the files stay.** Reads then depend on a different process that runs. When it stops, reads fail.
- **A pull request to Node.js for `fileControl`.** Not selected, by the decision of the maintainer of this repository.
- **A native library that SQLite loads.** This option was selected.

## Consequences

- An owner with `PersistentWriteAheadLog` keeps `-wal` and `-shm` beside its file. A program that deletes or renames the file must move or delete the two files too. Else a stale `-wal` file can replay into a new file with the same name.
- A bundle that uses `PersistentWriteAheadLog` keeps this package external, so the `lib` folder stays beside the code.
- The package ships native code for each platform ([ADR 0006](./0006-zig-builds-every-native-library-in-one-linux-job.md)).
