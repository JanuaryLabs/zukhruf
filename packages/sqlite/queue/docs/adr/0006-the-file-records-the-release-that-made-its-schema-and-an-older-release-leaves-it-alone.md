# The file records the release that made its schema, and an older release leaves it alone

The schema is a declaration with `rows: 'keep'` ([ADR 0004](./0004-the-schema-is-a-declaration-and-keeps-the-jobs.md)). A declaration says only whether the file stores its objects as declared. It does not say which of two declarations is newer. Two releases can run on one file: the pool for the computer (#3527) puts every host of a computer on one queue file, and an old plugin server keeps running after an update (#2127). Before this change, each `start()` of the older release rebuilt the tables to its own shape and discarded the columns that the newer release added. Then the next `start()` of the newer release added them again, without their values (backlog #4369).

pg-boss does not do this. Its `start()` migrates only when its `schemaVersion` is above the version that its `version` table holds (`node_modules/pg-boss/dist/contractor.js:79-91`). With a newer installed schema the test is false, and `start()` goes on with no change (`contractor.js:83`). An older pg-boss runs on a newer schema unchecked. That is a divergence here ([ADR 0002](./0002-the-parity-suite-is-the-contract.md)).

Thus `pgboss_version` has a `version` column, as the `version` table of pg-boss has (`plans.js:288-298`). It holds the version of the release of this package that last applied the schema. `start()` (`src/contractor.ts`) reads it and applies the declaration in one `IMMEDIATE` transaction, so two programs that start together cannot both act on the version that they read:

- The file records a later release: `start()` changes nothing and goes on.
- The file records this release, an earlier one, or none (a new file, or a file of a release before this column): `start()` applies the declaration, as before, and records this release.

The version is the `version` of the package's own `package.json`, read at run time. This workspace releases its public packages with fixed versioning, and each release raises the version. Thus no person keeps a number, and none can forget to raise one.

## Considered Options

- **A schema number that a person raises with each schema change, as `schemaVersion` of pg-boss.** pg-boss keeps an integer. ADR 0004 rejected such a number: a person can forget, and nothing finds it. A release whose change of `src/schema.ts` does not raise it would read as the same release, and two releases would again undo each other.
- **A version and a compatible version, as Chromium's `sql::MetaTable`.** An older release could then refuse a file that it cannot read, or open one that it can. pg-boss does neither: it runs on a newer schema unchecked. A compatible version would also be a number that a person keeps.
- **A direction in `@zukhruf/sqlite-drift`.** The drift of a declaration is about the text that SQLite stores. The order of two releases is a fact of the program that ships the declaration, not of the declaration, and pg-boss keeps it in its own `version` table. `@zukhruf/sqlite-notify` also keeps rows across releases, and can need the same rule (backlog #4388). When a third declaration needs it, the rule moves to one place.
- **The version of the package's own release.** No person keeps it, and it orders the releases. `@zukhruf/testing` names its shared servers by the same version (its ADR 0012). This option was selected.

## Consequences

- An older release on a newer file reads and writes the tables of the newer release. A column that the newer release added needs a default or must be nullable, as ADR 0004 requires. A column that it removed, or a meaning that it changed, breaks the older release, as it breaks an older pg-boss.
- Between two releases, the source in this workspace has the version of the last release. A program that runs that source on a file of the same version applies its declaration, as before this change.
- A release before this column records no version. Its `start()` still rebuilds a newer file to its own shape and drops the column. Only releases from this one on leave a newer file alone.
- `start()` turns foreign keys off around its transaction, because the rebuild of `pgboss_queue` needs them off and SQLite cannot change them inside a transaction. In a transaction of the caller, the keys stay as they are, and `start()` fails before it changes the file, as ADR 0004 says.
