# The file records the release that made its tables, and an older release leaves them alone

The tables are a `Declaration` of `@zukhruf/sqlite-drift` with `rows: 'keep'` (README, "The tables"). A declaration says only whether the file stores its objects as declared. It does not say which of two declarations is newer. The programs of one computer share the file, so two releases on one file are usual: an old program keeps running after an update (#2127, #3527). Before this change, each constructor of the older release rebuilt the tables to its own shape and discarded the columns that the newer release added. The next constructor of the newer release then added them again, without their values (backlog #4388).

`@zukhruf/sqlite-queue` had the same defect, and its [ADR 0006](../../../queue/docs/adr/0006-the-file-records-the-release-that-made-its-schema-and-an-older-release-leaves-it-alone.md) records the rule that fixed it, as pg-boss does. This package copies that rule.

## Decision

The table `zukhruf_notify_version` has one row. It holds the version of the release of this package that last applied the tables. The version is the `version` of the package's own `package.json`, read at run time. This workspace releases its public packages with fixed versioning, and each release raises the version. Thus no person keeps a number.

The constructor (`src/tables.ts`) first reads the version and the drift of the declaration in one snapshot, with no lock. A reader of a WAL file does not wait for a writer. Thus a file that needs no change gets its `Notifications` next to the write of another program:

- The file records a later release: the constructor changes nothing.
- The file records this release and fits the declaration: the constructor changes nothing.

Any other file needs a change. The constructor then reads the version again and applies the declaration in one `BEGIN IMMEDIATE` transaction, so two programs that start together cannot both act on the version that they read:

- The file now records a later release: the constructor changes nothing.
- The file records this release, an earlier one, or none (a new file, or a file of a release before this table): the constructor applies the declaration, as before, and records this release.

## Considered Options

- **`PRAGMA user_version`.** A file has one `user_version`. Backlog #4334 can put the tables of `@zukhruf/sqlite-queue` and of this package in one file. A declaration changes only the objects that it names, so a table of its own is the version of this package alone.
- **A schema number that a person raises with each change of `src/schema.ts`.** A person can forget, and nothing finds it. A release that changes the tables and keeps the number would read as the same release.
- **A direction in `@zukhruf/sqlite-drift`.** The order of two releases is a fact of the program that ships the declaration, not of the declaration. The queue's ADR 0006 rejected it for the same reason.
- **One shared package for the rule now.** This package is the second place of the rule. The Rule of Three waits for a third place (backlog #4393), and [the ledger](../copied-from-sqlite-queue.md) records the copy.
- **The version of the package's own release, in a table of its own.** This option was selected.

## Consequences

- An older release on a newer file reads and writes the tables of the newer release. A column that the newer release adds needs a default or must be nullable. A column that it removes, or a meaning that it changes, breaks the older release.
- Between two releases, the source in this workspace has the version of the last release. A program that runs that source on a file of the same version applies its declaration when the file does not fit.
- A release before this table records no version. Its constructor still rebuilds a newer file to its own shape. Only releases from this one on leave a newer file alone.
- The constructor applies the declaration inside its own `BEGIN IMMEDIATE` transaction. The tables have no foreign keys, so `@zukhruf/sqlite-drift` never needs foreign keys off for them. A table of the caller that refers to a table of this package with foreign keys on makes the apply fail, and the file stays as it was.
- A fix to this rule is made here and in `@zukhruf/sqlite-queue`, and the commit names both files, until the third place extracts it.
