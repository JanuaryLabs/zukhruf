# One open for readers and owners

This package was `@zukhruf/sqlite-reader`. It opened only readers, with `openReader(path)`. Each owner opened its connection with `new DatabaseSync` and did its own setup. A count across the zukhruf, elt, context-compiler, text2sql and deepagents repositories found about 74 source files and 150 test files that open SQLite, with different setups:

- The busy timeout was 0, 1000, 3000, 5000 or 30000 milliseconds, as an option or as `PRAGMA busy_timeout`. About 12 opens had none.
- About 11 owners wrote the same `PRAGMA journal_mode = WAL` block. Others kept the rollback journal without a reason.
- "The file is missing, or the system denies access" had four encodings in zukhruf, with different codes, and two encodings of error 14 did not agree.
- Five opens ran `PRAGMA foreign_keys = ON`, which `node:sqlite` already does.

Repository [ADR 0001](../../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md), rule 2, moves code into one home at the third place. The setup of a connection is in more than three places.

## Decision

- The package is `@zukhruf/sqlite-open`. It has one function, `open(path, options)`, with the options of `new DatabaseSync` except `open`. The change from `new DatabaseSync(path, options)` to `open(path, options)` is the only change at a call site.
- `readOnly: true` opens a reader, as `openReader` did. All other connections are connections of an owner, and `open` sets their journal ([ADR 0004](./0004-the-journal-is-a-strategy.md)).
- `openReader` is deleted, with no alias. Each caller changes.
- The rule `no-raw-database-sync` of `@zukhruf/eslint` reports `new DatabaseSync` of `node:sqlite` under any local name. It is in the `base` config, so it reaches each repository that uses it. It is off only in this package and in the SQLite fixture of `@zukhruf/testing`. That fixture cannot depend on this package, because this package tests with `@zukhruf/testing`, and it needs a busy timeout of 0 to hold a lock.

## Considered Options

- **Two functions, `openReader` and `openOwner`.** Two names for one constructor. A caller cannot change `new DatabaseSync(path, options)` by one name.
- **A class for each role: Reader, Owner, LockFile, PrivateCopy.** Four entry points. The roles differ only in the journal, which a strategy holds ([ADR 0004](./0004-the-journal-is-a-strategy.md)).
- **A separate owner package beside `@zukhruf/sqlite-reader`.** zukhruf releases all packages at one version, so a reader gains nothing from the split except a smaller install (16 KB). Two packages for one job.
- **One function with `readOnly`, as `node:sqlite` has it.** This option was selected.

## Consequences

- One place sets the journal, the busy timeout and the map of failures for every connection.
- A caller reads `open(path, { readOnly: true })` where it read `openReader(path)`.
- The lint rule makes each repository change its opens when it takes the new `@zukhruf/eslint`.
- `readOnly` is a boolean that changes the behavior. It stays, because it is the option of `node:sqlite`, and no other option is valid for only one of its values except `journal`, which the type refuses for a reader.
