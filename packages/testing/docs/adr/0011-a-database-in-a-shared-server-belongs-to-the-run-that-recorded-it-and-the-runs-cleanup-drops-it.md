# A database in a shared server belongs to the run that recorded it, and the run's cleanup drops it

`database()` of `Postgres`, `Mysql`, `Mariadb` and `SqlServer` creates a database named `test_<uuid>` on a shared server. Disposal is the only step that drops it. ADR 0006 cleans up a killed run: the global teardown, or the recovery of a later run, removes the containers and volumes that carry the run's label, and the paths in the forward and directory records. Shared servers outlive runs on purpose, and nothing records the databases in them. Thus a killed test process leaves its database in the shared server. A probe proved this on 2026-10-22. A process acquired `new Postgres({ environment }).database()` and got SIGKILL before its disposal. Its database `test_<uuid>` stayed. An empty Postgres database uses about 7.75 MB of the server's 512 MB tmpfs. Thus about 59 killed tests fill the tmpfs, and after that each `database()` on that server fails. The same applies to MySQL, MariaDB and SQL Server (backlog #2842).

Thus a database in a shared server becomes a thing that the run owns, as a container is. The owner is given by a record, not by a name:

1. After the acquisition of the shared server, and before `CREATE DATABASE`, the test process writes a database record in the run's directory with `TestRun.recordDatabase({ kind, server, database })`. `kind` is `postgres`, `mysql`, `mariadb` or `sqlserver`. `server` is the name of the shared server's container. The record comes before the create, so it also covers a create that is in progress when the process dies. The creating record of ADR 0006 follows the same rule.
2. Disposal drops the database, and then disposes the record. If the drop fails, the record stays, and the run's cleanup drops the database.
3. Each kind has one drop function. Disposal and the run's cleanup both use it:
   - Postgres: an exec of `psql` in the server's container, with `DROP DATABASE IF EXISTS … WITH (FORCE)`.
   - MySQL and MariaDB: an exec of the image's client (`mysql` or `mariadb`), with `DROP DATABASE IF EXISTS`.
   - SQL Server: the `mssql` driver, with `SET SINGLE_USER WITH ROLLBACK IMMEDIATE` and then `DROP DATABASE`. An exec is not possible, because the `azure-sql-edge` image has no `sqlcmd`.
4. `cleanup()` in `run-cleanup.ts` reads the database records next to the forward and directory records. The global teardown and the recovery of a later run both call it. For each database record, the cleanup:
   - finds the container by the name in `server`, and requires the label `dev.zukhruf.testing.shared=1`. Without that label, it throws "Invalid database cleanup record", as it does for the other kinds of record.
   - requires that the database name matches `^test_[0-9a-f]{32}$`.
   - drops the database with the drop function of the kind.
   - counts a server that is gone, or that does not run, as done. The engine removes a shared server when it stops, and its tmpfs databases go with it.
5. The cleanup reads the credentials from `Config.Env` of the server's container: `POSTGRES_USER`, `MYSQL_ROOT_PASSWORD`, `MARIADB_ROOT_PASSWORD` or `MSSQL_SA_PASSWORD`. The fixture set these values when it created the server. Thus the run's directory holds no secret.
6. The cleanup loads the module of a kind, and with it the driver of that kind, only when a record of that kind exists. Thus a consumer without `mssql` never loads `mssql`.

These drop functions are the collectors of backlog #2843 for databases on a Docker engine. A collector is the step that removes one kind of resource for a dead owner, as the garbage collector of Kubernetes removes the objects whose owner reference names a deleted owner.

`recordDatabase` has this name because each method of `TestRun` that writes a record names what it records: `recordProcess(pid)` and `recordCreating()`. `record(kind, path)` records a path that the cleanup removes from a file system. A database is not a path, and its record has three fields, so it does not use `record`. `recordDatabase` returns an `AsyncDisposable`, as the other methods do. Disposing it forgets the database after the process dropped it itself.

## Considered Options

- **The run's id in the database name**, such as `test_<runId>_<uuid>`. The cleanup never uses a name as proof of ownership, as the comment in `run-cleanup.ts` says: another run, project or person can create a database with a similar name. Also, `test_` + 32 + `_` + 32 is 70 bytes. Postgres cuts an identifier at 63 bytes, and MySQL refuses an identifier longer than 64 characters.
- **A comment or a label on the database.** MySQL and MariaDB have no comment on a database.
- **A cleanup that loads the drivers of all kinds.** Then the global teardown needs each optional driver, also in a project that uses none.
- **An exec for all kinds.** The `azure-sql-edge` image has no `sqlcmd`.
- **One database for each run, removed when the run ends.** Then the tests of one run share one database, and a test is no longer isolated.

## Consequences

- Each `database()` writes one record file, and its disposal removes it.
- The cleanup does one step for each recorded database.
- The SQL Server drop connects to the port that the server publishes on 127.0.0.1 of the engine's host. On an SSH engine, the cleanup opens an SSH forward to that port, as an acquisition does.
- BigQuery datasets, which are in the cloud, stay in backlog #2843. Runs on more than one machine that share one engine also stay there.
- The code step adds one test for each Docker kind: "a database whose test process was killed is dropped when the run ends". Each test has the shape of `src/scripts/docker-global-setup.integration.test.ts`.
