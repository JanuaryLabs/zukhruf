# The journal is a strategy

An owner selects a journal when it opens the database. The owners need four different setups:

- Most owners need a write-ahead log, so readers and the owner do not wait for each other.
- An owner whose readers cannot write the folder needs persistent WAL ([ADR 0003](./0003-persistent-wal-through-a-native-library.md)).
- `@zukhruf/fs` uses a SQLite file as a lock. Its `PRAGMA journal_mode = MEMORY` waits for the lock of the file, so it runs before each try of the lock, not at the open (`file-lock.ts`). An open that sets a journal fails with `SQLITE_BUSY` while another process holds the lock.
- The copy that `@zukhruf/sqlite-snapshot` reads of an exclusive owner must lose its hot journal, and a file that an owner builds and then renames must not leave a `-wal` file behind. Both need the rollback journal.

A string option such as `journal: 'wal'` makes `open` test the value to know whether to load the native library and whether a size limit applies. The size limit has a meaning only for a write-ahead log, so a string option has a field that is wrong for the other values.

## Decision

- `Journal` is an interface with one method, `apply(database)`. `open` calls it on the connection of an owner that has a file. Each journal is its own class, in its own file. This is the Strategy pattern ("Replace Conditional with Polymorphism", Fowler).
- `WriteAheadLog` is the default. It sets the write-ahead log, checks that SQLite gives `wal`, and sets `journal_size_limit` to 64 MiB (as Rails 8 does), so the `-wal` file does not stay large after a large commit.
- `PersistentWriteAheadLog` loads the native library, and then does the steps of `WriteAheadLog`.
- `RollbackJournal` sets the rollback journal, in SQLite's `DELETE` form, the only one that an owner needs. Its first access rolls back a hot journal.
- `UnchangedJournal` does nothing. It is a special case for an owner that sets its own journal ("Introduce Special Case", Fowler).
- The type of the options refuses `journal` together with `readOnly: true`.

## Considered Options

- **Persistent WAL for every owner.** Each host then needs the native library: a bundle must keep this package external, and an Electron app must unpack and validate it. Each file keeps `-wal` and `-shm`, which a delete or a rename of the file can leave behind. Only the files that readers without write permission read need it.
- **A string option.** See above.
- **A class for each role of the connection.** See [ADR 0002](./0002-one-open-for-readers-and-owners.md).
- **One strategy object for each journal, with a write-ahead log as the default.** This option was selected.

## Consequences

- A new journal is a new class that implements `Journal`. `open` does not change.
- A program that does not use `PersistentWriteAheadLog` loads no native code.
- An owner whose readers cannot write the folder must select `PersistentWriteAheadLog`. If it does not, those readers fail between two passes.
