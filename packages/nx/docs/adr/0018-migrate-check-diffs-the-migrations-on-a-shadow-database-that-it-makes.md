# migrate:check diffs the migrations on a shadow database that it makes

Status: Accepted 2026-11-20 by the owner (backlog #4937).

Nothing checked that the schema of a db package and its migrations agree. In meddit (#4926, #4928, #4968, 2026-11-20) agents ran `prisma migrate diff` by hand several times a day, and met four problems:

- Run by hand, Prisma does not load `packages/db/.env`, so it stopped with P4003 (no URL). An Nx task loads the project `.env`.
- With the models in `models/*.prisma`, `--to-schema schema.prisma` reports a diff that removes every table. The schema is the folder, `--to-schema .`, as `schema: '.'` in `prisma.config.ts` says (ADR 0012 decision 1).
- `--from-migrations` needs a shadow database, and the generated setup has none: `.env.example` writes `SHADOW_CONNECTION_STRING=` empty, and `compose.dev.yml` has one database. So the agents diffed against the dev database, whose state is not the migrations folder.
- The `migrate` target (`prisma migrate dev --create-only`) refuses a diff with a data-loss warning when it runs with no TTY, so the agents wrote the SQL of a migration from `migrate diff --script` by hand.

Facts read on 2026-11-20 with Prisma 7.10.1 (a scratch project and a Postgres 18 container):

- `migrate diff --from-migrations migrations --to-schema .` with no `datasource.shadowDatabaseUrl` stops with "You must set `datasource.shadowDatabaseUrl` in your `prisma.config.ts` if you want to diff a migrations directory", also when `datasource.url` is set. With a shadow URL whose database does not exist, it stops with P1003. Prisma 7 has no form that diffs a migrations folder without a shadow database, and it creates none for `migrate diff` (it does for `migrate dev`).
- With a shadow database, `--exit-code` exits 0 when the migrations build the schema, and 2 with the diff printed when they do not: "[+] Added column `age`" for a schema change with no migration, "[-] Removed tables - Visit" for a migration with no schema change. `datasource.url` is not read: a URL to a closed port gives the same result.
- `--to-schema .` reads each `*.prisma` file under the folder, `node_modules` too, as `schema: '.'` of the config does for `generate`.
- `prisma migrate dev --create-only` with no TTY wrote the migration for an "unexecutable step" warning (a required column on a table with rows), and stopped with "Prisma Migrate has detected that the environment is non-interactive, which is not supported" for a data-loss warning (a dropped column).
- `migrate diff --script --output <file>` creates the folders of `<file>`, and for an empty diff writes `-- This is an empty migration.`, as `migrate dev --create-only` does.
- In CI, the generated workflow starts no Postgres. The tests of a db package take their databases from `@zukhruf/testing/postgres`, on the Docker of `ubuntu-latest`.

## Decision

The prisma area gives each Prisma project two more targets, and both run a script of this package, `src/prisma/migrate-diff.ts`, that takes a new, empty database from `@zukhruf/testing/postgres`, gives it to Prisma as `SHADOW_CONNECTION_STRING`, and drops it after the diff.

1. **`migrate:check` runs `prisma migrate diff --from-migrations migrations --to-schema . --exit-code`.** It is cached. Its inputs are `{projectRoot}/**/*.prisma`, `{projectRoot}/prisma.config.ts`, `{projectRoot}/migrations/**/*` and the package `prisma`. When the diff is not empty, it prints Prisma's diff and one line that names the two ways out: a new migration with `migrate:create`, or a schema that matches the migrations.
2. **`migrate:create --name <name>` writes `migrations/<UTC time>_<name>/migration.sql`** with `--script --output`, the folder name of `prisma migrate dev`. It needs no TTY and no dev database, so it writes what the agents wrote by hand. Its SQL can still fail on a table with rows (a required column with no default); the person edits it, as after `migrate dev --create-only`.
3. **The shadow database is a database of `@zukhruf/testing/postgres`, not one of `compose.dev.yml`.** Prisma empties the shadow database each time it uses it, so it is a thrown-away database by nature, the reason ADR 0012 decision 16 gave against a test database for development. It needs no second host port, no `.env` entry and no CI step: the check runs on a laptop and in CI as the tests do. The script sets the variable itself, so a `SHADOW_CONNECTION_STRING` in `.env` or in the shell never gets emptied.
4. **The generator adds `migrate:check` to `targetDefaults.typecheck.dependsOn`**, as `format:check` is there (ADR 0001). The plugin does not change `typecheck` (ADR 0008). A repo that ran the generator before gets it from the `add-migrate-check` migration of 0.8.44.
5. **`@zukhruf/testing` is an optional peer of `@zukhruf/nx`.** The generator already adds it to the root of each repo with a db package (ADR 0012 decision 15).

## Considered Options

- **A second database in `compose.dev.yml` and its URL in `.env.example`, as #4937 first proposed.** Not selected. A second service needs a second host port in each repo, and a derived port collides across repos (factory's 5434 + 1 is meddit's 5435). A second database on the `database` service needs an init script that an existing volume never runs. CI has no `.env`, so the URL would need a step in the generated workflow, and the check would need the `up` target first, which applies the pending migrations to the dev database on each typecheck.
- **A test in each generated db package that runs the diff.** Not selected. It is a copy in each repo, a Docker test has no cache, and it gives no `migrate:create`.
- **The schema path and the migrations path read from `prisma.config.ts`.** Not selected. Only `@prisma/config`, which calls itself an internal package, reads the config; the CLI needs the paths as arguments. Each of the 10 configs that meddit, factory, text2sql and three other repos hold keeps the migrations in `migrations` and its schema in the project root, as a folder or as one `schema.prisma`.

## Consequences

- `migrate-diff.ts` reads its environment, the time, and writes to the console, which `island/no-process-env`, `island/no-ambient-time` and `island/no-console` refuse in library code. The root `eslint.config.mjs` turns the three rules off for the file, with its reason, as it does for `check-plan-fresh.ts` of the opentofu area.
- The typecheck of a db package needs Docker, as its test already does.
- A config that reads the shadow URL from another variable, or not at all (factory reads only `DATABASE_URL`), makes `migrate:check` stop with Prisma's message about `datasource.shadowDatabaseUrl`.
- The proof of 2026-11-20 on a workspace that the prisma generator wrote (Nx 24.0.6, Prisma 7.10.1): `migrate:check` passed on the empty package, `migrate:create --name init` wrote the table of a new model, `migrate:check` passed and then replayed from the cache, failed on a column with no migration and on a migration with no model, and the typecheck failed with it; a `SHADOW_CONNECTION_STRING` in `.env` that named another database kept its table.

## Amendment 2026-11-25: the shadow database follows the provider of the schema (#5625)

The script started a Postgres shadow database for each db package. A db package whose schema has `provider = "sqlite"` (text2sql `apps/desktop/db`) then failed `migrate:check`: Prisma opened the Postgres URL as a SQLite file, "SQLite database error, unable to open database file: postgresql://…".

Facts read on 2026-11-25 with Prisma 7.10.1 (a scratch project, a SQLite schema and one migration):

- With no `datasource.shadowDatabaseUrl`, `migrate diff --from-migrations migrations --to-schema . --exit-code` exits 0 when the migrations build the schema, and 2 with "[+] Added tables" when they do not. It writes no file: Prisma replays SQLite migrations on an in-memory database. The "You must set `datasource.shadowDatabaseUrl`" stop is for the Postgres provider only.
- With `--script --output <file>`, it writes the SQL of the diff, as for Postgres.
- With a `postgresql://` shadow URL, it stops with the error above (`sql_schema_connector::flavour::sqlite::sql_schema_from_migration_history`, `external_shadow_db=Yes`).

Decision 3 now holds for the `postgresql` provider only. The script reads the `provider` of the `datasource` block from the `*.prisma` files of the project folder, and each provider has its own shadow type:

- `postgresql`: a new database of `@zukhruf/testing/postgres` as `SHADOW_CONNECTION_STRING`, as before. The script imports `@zukhruf/testing/postgres` only for this provider, because `@zukhruf/testing` is an optional peer (decision 5).
- `sqlite`: no variable and no database. Prisma uses its in-memory shadow database.
- Any other provider: the script stops before Prisma with an error that names the provider. Before, Prisma got a Postgres URL and failed with its own error.

A SQLite db package needs no Docker for `migrate:check` and `migrate:create`. A `SHADOW_CONNECTION_STRING` in `.env` or in the shell of a SQLite package reaches Prisma unchanged, so a person can still name a shadow file.
