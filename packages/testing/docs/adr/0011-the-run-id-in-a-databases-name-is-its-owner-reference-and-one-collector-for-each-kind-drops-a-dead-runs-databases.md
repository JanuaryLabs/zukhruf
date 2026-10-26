# The run id in a database's name is its owner reference, and one collector for each kind drops a dead run's databases

`database()` of `Postgres`, `Mysql`, `Mariadb` and `SqlServer` creates a database named `test_<uuid>` on a shared server. Disposal is the only step that drops it. ADR 0006 cleans up a killed run: the global teardown, or the recovery of a later run, removes the containers and volumes that carry the run's label, and the paths in the forward and directory records. Shared servers outlive runs on purpose, and nothing marks the databases in them with a run. Thus a killed test process leaves its database in the shared server. A probe proved this on 2026-10-22. A process acquired `new Postgres({ environment }).database()` and got SIGKILL before its disposal. Its database `test_<uuid>` stayed. An empty Postgres database uses about 7.75 MB of the server's 512 MB tmpfs. Thus about 59 killed tests fill the tmpfs, and after that each `database()` on that server fails. The same applies to MySQL, MariaDB and SQL Server (backlog #2842).

A failed drop also leaves a database. Disposal ignores the error of its drop: Postgres, MySQL and MariaDB call `.catch(() => {})`, and SQL Server has an empty `catch`.

Backlog #2843 gives the standard for the resources of a run. Each resource carries an owner reference: the run id, in the native slot of its kind. "Owner reference" is the Kubernetes term for a reference from a resource to the object that owns it. One collector for each kind lists the resources by that owner reference and removes each one. A container already follows this standard: its native slot is a label, and `cleanup()` lists the containers by the run's label. A database has no label. Its native slot is its name.

Thus a database in a shared server becomes a thing that the run owns, as a container is:

1. In a run, `database()` names the database `test_<run id>_<random>`. `<run id>` is the run's id as 32 hex characters, without hyphens. `<random>` is 16 random hex characters. The name has 54 bytes. Postgres allows 63 bytes for an identifier, MySQL and MariaDB allow 64 characters, and SQL Server allows 128 characters. The name is set before `CREATE DATABASE`, so it also marks a create that is in progress when the process dies. Outside a run, the environment gives no run id. Then `database()` keeps the name `test_<32 hex>`, and only disposal drops it.
2. Each database fixture adds a kind label to the shared server through the `labels` of its options: `dev.zukhruf.testing.kind`, with the value `postgres`, `mysql`, `mariadb` or `sqlserver`. `reuse()` puts the labels in the fingerprint of the configuration, and the fingerprint gives the name of the server. Thus a server that was created before this change has a different name, and `reuse()` does not give it again. Each server that holds a database with a run id has the kind label.
3. Each kind has one drop function. Disposal and the collector both use it:
   - Postgres: an exec of `psql` in the server's container, with `DROP DATABASE IF EXISTS … WITH (FORCE)`.
   - MySQL and MariaDB: an exec of the image's client (`mysql` or `mariadb`), with `DROP DATABASE IF EXISTS`.
   - SQL Server: the `mssql` driver, with `SET SINGLE_USER WITH ROLLBACK IMMEDIATE` and then `DROP DATABASE`. An exec is not possible, because the `azure-sql-edge` image has no `sqlcmd`. On an SSH engine, the collector opens a forward to the published port with `DockerHost(endpoint).forward(port)`, as an acquisition does.
4. Each kind has one collector. The collector lists the databases of one server whose name matches `^test_<run id>_[0-9a-f]{16}$`, and drops each one with the drop function of the kind.
5. `cleanup()` in `run-cleanup.ts` runs the collectors. The global teardown and the recovery of a later run both call it. It lists the containers that carry the label `dev.zukhruf.testing.shared=1` and a kind label. For each container, it runs the collector of that kind with the id of the run that it cleans. It reads the credentials from `Config.Env` of the server's container: `POSTGRES_USER`, `MYSQL_ROOT_PASSWORD`, `MARIADB_ROOT_PASSWORD` or `MSSQL_SA_PASSWORD`. The fixture set these values when it created the server.
6. A server that does not run counts as done. Its databases are on a tmpfs, and the engine removes a shared server when it stops.
7. When the driver of a kind does not load, for example because the project did not install `mssql`, `cleanup()` skips the servers of that kind. The run's test processes used the same project, so they could not create a database of that kind.
8. Each drop is `IF EXISTS`, so a second sweep of the same run does nothing. Thus the global teardown and a recovery need no lock between them.

This covers a killed test, a create that was in progress when the process died, and a drop that failed in disposal. No record file is necessary, and `TestRun` gets no new method. The fixture reads the run id from the environment that it already takes.

"Collector" is the term of backlog #2843. The Kubernetes garbage collector deletes each dependent object through the API of its own type. Boskos calls the cleaner of one resource type a janitor.

The comment in `run-cleanup.ts` says: never trust names alone as proof of ownership. That rule is about Docker objects, which have labels. A database has no label, so its name is the only slot for the owner reference. The collector does not trust the name alone. It looks only in the shared servers of this package, which it finds by label, and it requires the exact pattern with the run's id.

## Considered Options

- **A database record in the run's directory** (the previous draft of this ADR, with `TestRun.recordDatabase`). The record is on the disk of one test machine. Backlog #2843 sweeps the runs of many machines that share one engine, and that sweep cannot read the record. The record also adds a method to `TestRun`.
- **A comment on the database.** MySQL and MariaDB have no comment on a database.
- **One database for each run, dropped when the run ends.** Then the tests of one run share one database, and a test is no longer isolated.
- **The kind from the image name, without a kind label.** A consumer can give a custom `image`, and then the image name does not give the kind.
- **A cleanup that loads the drivers of all kinds.** Then the global teardown needs each optional driver, also in a project that uses none. The skip rule in step 7 prevents this.
- **An exec for all kinds.** The `azure-sql-edge` image has no `sqlcmd`.

## Consequences

- Each global teardown lists the shared servers on the engine. For each server of a kind whose driver loads, it sends one list query.
- The new names start new shared servers, one time for each configuration. The old servers keep only their old `test_<32 hex>` databases. Nothing removes these servers or databases. That is the present behavior for shared servers: stop the server to remove it.
- Runs on more than one machine that share one engine use the same collectors when backlog #2843 adds a lease that tells which run ids are dead. BigQuery datasets also stay in backlog #2843.
- The code step adds these tests, in the shape of `src/scripts/docker-global-setup.integration.test.ts`:
  - "a database whose test process was killed is dropped when the run ends", one for each Docker kind.
  - "the run's cleanup leaves the databases of another run on the same server". It proves that a collector drops only the names of its own run.
