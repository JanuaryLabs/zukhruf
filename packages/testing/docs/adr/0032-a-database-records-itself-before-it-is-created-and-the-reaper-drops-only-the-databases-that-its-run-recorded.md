# A database records itself before it is created, and the reaper drops only the databases that its run recorded

Status: Accepted 2026-11-26 (backlog #5739, #5751).

Decision-makers: the zukhruf session mutex-63, from the top performers, in the paper that Ezz accepted on 2026-11-26 ("Approve, build it"), after he asked for the reaper to "avoid limits and let it be natural"; the zukhruf session mutex-db, from the evidence, for the id of the server in the record and for a paused server.

`database()` of `Postgres`, `Mysql`, `Mariadb` and `SqlServer` creates a database on a shared server. Before this decision, the reaper found the databases of its run by a scan (ADR 0011, ADR 0020 item 8). It listed each running container with the labels `dev.zukhruf.testing.server` and `dev.zukhruf.testing.kind`, ran the client of the server in it to list each database whose name starts with `test`, and dropped each database whose name had the id of its run.

The scan visited each shared server of the engine, also the servers of other runs and of other sessions:

- In the whole suite on desktop-linux, the calls of the reaper into about 8 shared servers of other runs hit the 1 s request time limit of a test, and a pass whose list hit the limit dropped nothing (#5751).
- One shared server that does not answer slowed the pass of each reaper on the engine. A test kept such a server, and it had to run alone, after the other tests.
- The engine log of 2026-11-26 on desktop-linux shows the reapers of other sessions: each pass ran `psql` or `mysql` in each shared server of the engine, about every 1.6 s.

No top performer scans the servers to find what to remove. The Kubernetes garbage collector reads the owner that the dependent names (`ownerReferences`, written when the dependent is created, with the `uid` of the owner) and deletes a dependent whose owner is gone ([Owners and Dependents](https://kubernetes.io/docs/concepts/overview/working-with-objects/owners-dependents/); `isDangling` in `pkg/controller/garbagecollector/garbagecollector.go` asks for the owner with a live GET). Django and pytest-postgresql drop a test database through the handle that created it, by its known name.

## Decision

1. **In a run, `database()` writes a database record before it creates the database.** The record is a volume `zukhruf-testing-database-<name>`. It has the label of the run (`dev.zukhruf.testing.run`), `dev.zukhruf.testing.database=<name>`, `dev.zukhruf.testing.database.server=<the id of the shared server>` and the kind label `dev.zukhruf.testing.kind`. A process that dies after the record leaves a database that the record names. A process that dies before the record leaves no database. Outside a run, `database()` writes no record, because no reaper reads it. One function, `createSharedDatabase` in `src/databases/database-record.ts`, holds this order for the three fixtures.
2. **The disposal drops the database, and then removes the record.** A drop that fails rejects, and the record stays. A shared server that is gone or stopped (`exited`, `dead` or `removing`) took its databases with it, so that drop resolves. A paused server still holds its databases, so that drop rejects. Before this decision, `dropDatabase` read each `ContainerNotRunningError` as a server that is gone, also for a paused server.
3. **The pass of the reaper drops each database that its run recorded, and visits no other shared server.** After it removes the run's containers, it reads the records of its run. For each record, it drops the database in its server with the client of the kind (`DROP DATABASE IF EXISTS`, and `IF DB_ID(…) IS NOT NULL` on SQL Server), and removes the record when the drop succeeded or the server ended. A record whose drop failed stays, and the next reaper of the run drops its database. Then the pass removes the other volumes of the run. The states of a server that ended are one set, `ENDED` in `src/databases/collector.ts`, for the disposal and for the script of the reaper.
4. **The record names the server by its id, not by its fingerprint.** The data directory of a shared server is a tmpfs, so a server that a later process starts with the same fingerprint does not hold the database. Kubernetes names an owner by its `uid` for the same reason: a new object with the same name is not the owner.

The id of the run stays in the name of the database (ADR 0011). It tells a reader which run created a database.

## Considered Options

- **Keep the scan, with no time limit for each call.** It still visits each shared server of the engine, of each run and each session, and one slow server still slows each reaper.
- **A record that names the fingerprint of the server**, as the paper first wrote. A new server with the same fingerprint does not hold the database (item 4).
- **A label on the shared server.** Docker sets the labels of a container only when it creates it, and the server exists before the database.
- **A record in the run's records on the machine of the test process.** The reaper runs on the engine's host and cannot read them (ADR 0020 item 6).

## Consequences

- During a run, `docker volume ls` shows one volume `zukhruf-testing-database-<name>` for each database that a test process holds.
- A database that an earlier version created on a shared server has no record, so no reaper drops it. The TTL of its server (7 days, ADR 0019) removes it with the server.
- ADR 0011 (the owner reference) and ADR 0020 item 8 (the scan) are superseded in part.
- When the removal of a server ends a drop that runs in it, this reaper keeps the record: `docker exec` exits 137 at once, and the server still reads `running` at that moment (5 of 5 probes on Engine 29.9.3, 2026-11-26). The next reaper of the run, which reads the server as gone, removes the record. A retry on the next event of the server, a later step of #5739, removes it in the same reaper.
- The list of the databases of each shared server is gone, and its test went with it: "a reaper whose list of the databases of a shared server hits its request time limit…" counted one line for each list (#5751). The two tests of a drop that never answers, or whose server is removed during the drop, now give their fake server a database record, because no fixture makes such a server.
- The other mechanisms of the paper (no time limit for each call, the collection of orphans, the lease of the creator) come in later steps of #5739 and #5751.

## Confirmation

Each test went red on the code before this decision, for the reason it names, and then green:

- `src/docker/reaper.integration.test.ts`:
  - "a process killed while database() writes the record of its database leaves no database of its run on the server": the proxy holds the create of the record, the test kills the worker, and the proxy refuses the create. Red: the worker printed its database before any record.
  - "a reaper drops the database that its run recorded and makes no exec in any other shared server": each request of the reaper goes through the proxy, and each exec targets the recorded server only. Red twice on the scan: the database stayed, and the reaper kept its container after a call hit the 10 s limit under the load of other sessions.
  - "a reaper keeps the record of a database whose drop fails, and the next reaper of its run drops that database". Red: the pass removed the record with the run's volumes.
  - "a reaper removes the record of a database whose server is gone".
  - "a reaper removes the record of a database that its process dropped and was killed before it removed the record", for each kind. Red for MySQL, MariaDB and SQL Server, which wrote no record.
- `src/scripts/database-cleanup.integration.test.ts`:
  - "a database whose test process was killed is dropped by the reaper after the run ends", for each kind, unchanged. It now passes only through the records.
  - "a disposal drops its database and removes its record", for each kind.
  - "a disposal whose drop fails rejects, and keeps the database and its record". Red: the disposal resolved on a paused server.

Mutation proof (write-test's `mutate.mjs`, each mutant in memory):

- CAUGHT: the create before the record; a scan of each shared server added back to the pass; a failed drop that removes the record; a removal of the other volumes that also takes the records; no `ended` check; a gone server that is not ended; a pass that reads no record; a drop that does nothing, for MySQL and SQL Server (the test of a killed test process times out); a disposal that keeps its record, for each kind; a drop that is not idempotent, for each kind; a disposal that removes the record and does not drop; a paused server that counts as ended, in the reaper and in `dropDatabase`.
- Not proven: the states `exited`, `dead` and `removing` in `ENDED`. A mutant that leaves them out passes, because a shared server runs with `AutoRemove` and is in these states only while the engine removes it, and no operation of a test keeps it there.
