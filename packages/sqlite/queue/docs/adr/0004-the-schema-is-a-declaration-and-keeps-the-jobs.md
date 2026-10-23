# The schema is a declaration and keeps the jobs

The queue file keeps the jobs and the schedules after the program stops. A new release of this package can change a table or an index, for example to add a column for the supervisor. Then `start()` opens a file that an earlier release made, and the tables in the file are not the tables that the new code reads.

Before this change, `start()` ran `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS`. SQLite skips such a statement when the file has an object with that name, also when the object is different. The rule was: delete the queue file of an earlier release. A program that kept such a file saw these failures:

- A file from before the schedule kinds (text2sql 139a749f) has no `kind` column in `pgboss_schedule`. `schedule()` throws `table pgboss_schedule has no column named kind`, and the cron pass does not send the stored schedule.
- A file from before the supervisor (text2sql 4caf2db1) has no count columns in `pgboss_queue`. Each worker poll fails, and no job runs.
- A file from text2sql 98d1eda8 has `pgboss_job_singleton_i` without `UNIQUE`. A singleton queue then runs two jobs of one key at the same time.

When a program deletes the file, it loses its jobs and its schedules. pg-boss does not do that. It keeps a schema version, and its `start()` migrates an installed schema that has an earlier version (`node_modules/pg-boss/dist/contractor.js:79-91`). The jobs stay.

Thus the schema is a `Declaration` of `@zukhruf/sqlite-drift`, with `rows: 'keep'` (`src/schema.ts`). Each element is one `CREATE` statement without `IF NOT EXISTS`. `start()` applies it: it makes each missing object, rebuilds each stale table and keeps its rows, and replaces each stale index. The connection pragmas stay before it, because a caller can give its own `database`. The cron claim row of `pgboss_version` is data, not a declared object, so `start()` adds it after the declaration with `INSERT OR IGNORE`.

## Considered Options

- **Delete the queue file of an earlier release.** The jobs and the schedules are lost, and a program sees the failures only at run time. pg-boss keeps the jobs.
- **A version number and a list of migrations, as in pg-boss.** Each release must write a migration and raise the number. A person can forget, and nothing finds it. The engine is SQLite here, so the migrations of pg-boss do not apply.
- **A declaration with `rows: 'keep'`.** The package compares the text that SQLite stores with the declared text, and no person keeps a number. This option was selected.

## Consequences

- No release writes a migration. A change to a `CREATE` statement in `src/schema.ts` is the change to the files.
- A column that a release adds needs a default or must be nullable. Otherwise the kept rows do not fit, and `start()` fails with the error of SQLite. The file then stays as it was.
- A column that a release removes is discarded with its values. A renamed column reads as a removed column and an added column.
- When `pgboss_queue` is stale, the rebuild turns foreign keys off around its own transaction, because `pgboss_job` and `pgboss_schedule` refer to it. In a transaction of the caller, `start()` then fails before it changes the file.
- A change of meaning with no change of text is not found. When the meaning of a column changes, change its name too.
