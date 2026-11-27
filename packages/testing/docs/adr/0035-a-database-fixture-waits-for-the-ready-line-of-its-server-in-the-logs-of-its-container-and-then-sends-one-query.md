# A database fixture waits for the ready line of its server in the logs of its container, and then sends one query

Superseded in part on 2026-11-27 (#6219) for the query after the ready line: a fixture waits for its ready line only, with `forLogMessage` as its wait strategy ([ADR 0036](./0036-a-service-waits-until-it-is-ready-with-a-wait-strategy-that-the-testbed-runs-under-a-startup-time-limit-and-a-container-that-stops-fails-with-its-exit.md)).

Status: Accepted 2026-11-27 (backlog #6085).

Decision-makers: the zukhruf session mutex-0a, from the probes below.

The `healthy` check of a database fixture runs on every acquisition, and the acquisition fails when the container exits first (see the README, section Docker). Before this decision, each fixture sent its query to the server every 250 ms until it answered, with `retryUntilReady`: an exec of `pg_isready` and `psql` for Postgres, of the client for MySQL and MariaDB, and a TDS connection for SQL Server. Each try is an engine call or a connection, and the answer comes up to 250 ms after the server is ready.

Each of these servers writes a line to its console when it is ready, and the engine gives the logs of a container as a stream (`GET /containers/{id}/logs?follow=1`). That stream is a push: it gives each line when the server writes it. The entrypoints of the Postgres, MySQL and MariaDB images first start a temporary server for the initialization, which writes a ready line too, so the line of the final server must be told apart from that one.

## Decision

1. **A fixture waits for the ready line of its server in the logs of its container, and then sends one query.** `waitForLogMessage(container, message, { times, timeout, signal })` in `src/databases/log-message.ts` follows the logs with `container.followLogs()`, from the start of the container, so a line that came before the call counts. It splits standard output and standard error into lines, each stream on its own, and resolves at the `times`-th line that contains `message`. Then the fixture sends the query that it sent before, one time:

   | Fixture            | Ready line                                               | Then                                                                 |
   | ------------------ | -------------------------------------------------------- | -------------------------------------------------------------------- |
   | `Postgres`         | the 2nd `database system is ready to accept connections` | `psql -h 127.0.0.1 … SELECT 1`                                       |
   | `Mysql`, `Mariadb` | the 1st line with `port: 3306  ` (two spaces)            | the client, `-h 127.0.0.1 … SELECT 1`                                |
   | `SqlServer`        | the 1st `Recovery is complete`                           | `#ping`: `SELECT 1`, and `IsFullTextInstalled` with `fullTextSearch` |

2. **Each fixture keeps its time limit**, now the limit of the wait for the line: Postgres 60 s, MySQL and MariaDB 90 s, SQL Server 180 s. At the limit, the wait rejects with how many of the lines came.
3. **A container that stops before the line fails as before, by the exit of the container.** The logs end when the container stops. The wait then waits for its `signal`, which the testbed aborts when the container exits first, so the acquisition rejects with the exit code and the output of the container.
4. **`ClickHouse` keeps `retryUntilReady`.** Its server writes its log to `/var/log/clickhouse-server`, and its console gets no ready line.

## Considered Options

- **A `HEALTHCHECK` and the `health_status` event.** The engine runs the check inside the container at its `Interval`, so the engine polls in place of the fixture: the answer comes no sooner, and each check is still an exec.
- **`retryUntilReady`, a query every 250 ms.** A poll: an engine call or a connection each 250 ms, and up to 250 ms late. It stays for ClickHouse, which writes no ready line to its console.

## Consequences

- An acquisition makes one log stream and one query, in place of a query every 250 ms.
- A server whose image writes another ready line, or none, waits until its time limit. The error then says how many of the lines came, and `serve` adds the output of the container.
- The engine must keep the logs of the container: the `json-file` and `local` log drivers do, and a container with the `none` driver has no logs to follow.
- The SQL Server query after the line has the connection and request timeouts of `mssql` (15 s each), in place of 1 s for each try of the poll.

## Confirmation

Probes on Docker Engine 29.9.3, 2026-11-27 (the table "S5 probes" of the survey of #6085):

- `postgres:18-alpine`, plain and with the WAL `Cmd`: the 1st `database system is ready to accept connections` (about 0.9 s) comes from the initialization server on its socket, and the 2nd (about 1.1 s) from the final server. `psql -h 127.0.0.1 SELECT 1` right after the 2nd line gives 1.
- `mysql:lts` (9.7.4): `mysqld: ready for connections. Version: …  port: 3306  MySQL Community Server`. The initialization server writes the same line with `port: 0`, and the X Plugin line has `port: 33060`. `mysql -h127.0.0.1 -P3306 select 1` right after the line gives 1.
- `mariadb:lts` (12.3.3): the line after `ready for connections.` is `Version: '…'  socket: …  port: 3306  mariadb.org binary distribution`; the initialization server writes `port: 0`. `mariadb -h127.0.0.1 -P3306 select 1` right after the line gives 1.
- `mcr.microsoft.com/mssql/server:2022-latest` (x86_64, native): `SQL Server is now ready for client connections` at 1.76 s, `Recovery is complete` at 3.03 s. `sqlcmd -C -S localhost -U sa SELECT 1` gives 1 right after each line.
- `clickhouse/clickhouse-server:25.8.28.1`: the console gets 5 lines and no `Ready for connections`.

Sources of the top performers: testcontainers-go MySQL waits for `wait.ForLog("port: 3306  MySQL Community Server")` (`modules/mysql/mysql.go:62`); testcontainers-node MSSQL waits for `Wait.forLogMessage(/.*Recovery is complete.*/, 1)` (`packages/modules/mssqlserver/src/mssqlserver-container.ts:10,14`).
