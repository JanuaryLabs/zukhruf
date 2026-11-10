# A write-ahead log syncs at checkpoints

An owner with a write-ahead log had the synchronous setting of the `node:sqlite` build: `FULL` (2). With `FULL`, SQLite syncs the `-wal` file to the disk at each commit. With `NORMAL` (1), SQLite syncs the `-wal` file only before each checkpoint.

The SQLite documentation ("PRAGMA synchronous") gives the cost of `NORMAL` in a write-ahead log. The database file stays consistent. A crash of the program loses no commit, because the operating system keeps the writes. A power loss or a crash of the operating system can roll back the commits after the last checkpoint. The documentation also says: "The synchronous=NORMAL setting is a good choice for most applications running in WAL mode."

A benchmark on 2026-11-10 measured the two settings through `open` on Node 26.13.0. The runs alternated the settings.

| Where                            | Work                       | `FULL`            | `NORMAL`          |
| -------------------------------- | -------------------------- | ----------------- | ----------------- |
| Linux container, 4 CPUs, overlay | Commits of one 1 KiB row   | 4,600–5,100 / s   | 56,000–64,000 / s |
| Linux container, 4 CPUs, overlay | `send` of `SqliteJobQueue` | 1,400–1,700 / s   | 8,200 / s         |
| macOS, APFS                      | Commits of one 1 KiB row   | 17,000–19,000 / s | 21,000–44,000 / s |
| macOS, APFS                      | `send` of `SqliteJobQueue` | 4,900–6,400 / s   | 5,800–6,700 / s   |

On macOS a sync does not flush the cache of the disk, so the difference is smaller there. On Linux a sync flushes the disk, and each commit of `FULL` waits for it.

## Decision

- `WriteAheadLog` sets `PRAGMA synchronous = NORMAL` after it sets the write-ahead log. `PersistentWriteAheadLog` does the same, because it runs the steps of `WriteAheadLog`.
- The option `synchronous: 'full'` keeps the sync at each commit, for example `new WriteAheadLog({ synchronous: 'full' })`. An owner whose commits must survive a power loss gives it. `@zukhruf/sqlite-queue` gives it (its ADR 0005).
- The option has two values, `'normal'` and `'full'`. `OFF` can damage the database file at a power loss. `EXTRA` has no caller.
- The other journals do not change the synchronous setting.

## Considered Options

- **Keep `FULL` for each owner.** Each commit on Linux then waits for the disk, and most owners do not need it. Their data comes again from its source: an import runs again, and a changefeed sends its events again from its position.
- **`NORMAL` for each owner, with no option.** The queue then loses a job that it acknowledged, at a power loss. pg-boss on Postgres does not lose it.
- **`NORMAL` by default, and `synchronous: 'full'` for an owner that needs it.** This option was selected.

## Consequences

- Each owner with a write-ahead log commits faster on Linux. The repositories that use the package get this setting at their next upgrade.
- A power loss can roll back the last commits of such an owner. The database file stays consistent.
- `synchronous` is a setting of the connection, not of the file. A different connection that writes the same file keeps its own setting.

## The same concepts in other systems

- Rails 8 sets `synchronous = NORMAL` for each SQLite database, together with its write-ahead log and `journal_size_limit`.
- Litestream tells its users to set `synchronous = NORMAL` with a write-ahead log.
- `@photostructure/sqlite` builds SQLite with `SQLITE_DEFAULT_WAL_SYNCHRONOUS=1`, which is `NORMAL` in a write-ahead log.
