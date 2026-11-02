# The version of an exclusive owner is the stamp of its database file

Some owners let no reader in. Chromium opens each database with SQLite's exclusive locking mode, and a running Chrome or Dia keeps the lock on its History. `new DataVersion(path)` reads `PRAGMA data_version` through its own connection, and that read fails with `SQLITE_BUSY` (5), "database is locked". A probe on 2026-11-02 showed this on the History of a running Dia.

Such an owner uses a rollback journal. Each commit writes the changed pages into the database file. A transaction that the owner did not commit writes the journal, and it writes the database file only when its pages do not fit in the cache.

## Decision

`DataVersion.ofExclusiveOwner(path)` observes the file stamp of the database file (`@zukhruf/fs`). Each commit writes the file, so its stamp changes, also when the owner keeps the size. The data version then counts the changes of the stamp, as it counts the changes of `data_version` for a WAL owner.

The journal is not a part of the observation. A write to the journal alone is a transaction that the owner did not commit. A reader that read again would find no new commit.

A path that this process cannot see keeps the last observation, as `new DataVersion` does. The owner can delete the file and create it again a short time later.

## Considered Options

- **Read `PRAGMA data_version`.** The lock of the owner stops the read.
- **The stamps of the database file and the journal.** Each write of an open transaction changes the version, and the reader reads again for nothing.
- **File-change events.** An event can come late, and it does not tell a commit from a write of the journal.
- **The stamp of the database file.** This option was selected.

## Consequences

- `@zukhruf/sqlite-data-version` depends on `@zukhruf/fs` for the file stamp.
- An open transaction that spills its pages into the database file changes the version. The reader then reads the last commit again. That costs one read.
- `@zukhruf/sqlite-snapshot` reads such an owner from an owner copy ([sqlite-snapshot ADR 0003](../../../snapshot/docs/adr/0003-an-exclusive-owner-is-read-from-a-checked-copy.md)).
