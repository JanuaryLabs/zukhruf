# A service waits until it is ready with a wait strategy that the testbed runs under a startup time limit, and a container that stops fails with its exit

Status: Accepted 2026-11-27 (backlog #6219). It supersedes [ADR 0035](./0035-a-database-fixture-waits-for-the-ready-line-of-its-server-in-the-logs-of-its-container-and-then-sends-one-query.md) in part, for the query after the ready line.

Decision-makers: the zukhruf session push-based-docker-waits, from a 5-whys chain, a map of every readiness site and the sources of testcontainers-node 12.2.2 and testcontainers-go v0.45.0. Ezz asked for the 5 whys and approved this paper ("Write the paper").

The mutation proof of ADR 0035 (28d6926b) left 5 of 7 mutants alive. The 5 whys trace them to one cause: the package has no model of readiness.

1. The wait for the ready line (`src/databases/log-message.ts`) has no test of its own. The fixtures reach it only through acquisitions that succeed. The query after the line has no job: no test needs it, and the leaders send none.
2. That wait is a private helper. It is the 7th hand-written loop that follows the logs until a line comes. 5 of the 6 loops that wait for readiness decode stdout and stderr with one decoder, so a line of one stream can join a part of a line of the other.
3. Readiness is a free function: `healthy(service, signal)`. Each of the 17 `healthy` functions writes its own wait: 5 polls with `retryUntilReady`, log loops, banner reads and queries. Each one picks its own time limit (60 s, 90 s, 180 s, or none). `testbed.start()` has no readiness at all, so 3 tests follow the logs by hand.
4. The testbed grew around one strategy: poll until a query answers. `timebox` became `retryUntilReady`, "the readiness retry it always was" (7075d382). A function was enough for a poll.
5. The sources that push were not primitives: the events at the engine clock came with `watch()` (#6085), and `followLogs()` gives frames of bytes, not lines.

The leaders model readiness as a wait strategy (testcontainers-node `build/wait-strategies/wait.d.ts`: `Wait.forLogMessage(message, times)`, `forHealthCheck()`, `forListeningPorts()`, `forHttp()`, `forSuccessfulCommand()`, `forOneShotStartup()`, `forAll()`; testcontainers-go `wait/`: `ForLog().WithOccurrence(n)`, `ForHealthCheck()`, `ForExec()`, `ForSQL()`, `ForListeningPort()`, `ForExit()`, `ForAll()`). Both give a strategy a startup time limit of 60 s by default. Neither reports the exit of the container well: node has no general check (its log wait fails when the stream ends), and go polls the state inside each strategy and gives the exit code but not the output.

The testbed already does better on the exit: it attaches to the container before the start and races the end of the attach against `healthy`, and that error has the exit code and the output. But backlog #4913 stays open: a `healthy` that throws its own error on a stopped container can settle first, and then the caller gets that error in place of the exit.

## Decision

1. **A service declares how to wait until it is ready: `wait: { until, timeout }`.** `until` is a wait strategy, `(target, signal) => Promise<void>`. `timeout` is the startup time limit, in milliseconds: the readiness bound of the README. `serve()` and `reuse()` take it in place of `healthy`, and `start()` takes it too. The two fields come together or not at all, so a strategy without a limit, or a limit without a strategy, cannot be written. The testbed owns the limit: the strategy gets a signal that aborts at the limit and when the container stops.
2. **`forLogMessage(message, { times })` is the one strategy that the package exports.** It resolves at the `times`-th line, since the container started (`State.StartedAt`, so a restarted container does not count the lines of an earlier run), that contains `message` (a string) or matches it (a `RegExp`). It splits stdout and stderr into lines, each stream on its own: the engine sends a line of more than 16 KiB as more than one frame, and a frame of the other stream can come between them. It decodes UTF-8 across frames. When the logs end before the line, it rejects.
3. **A container that stops before it is ready fails with its exit, also when the strategy rejects first.** When the strategy rejects, the testbed inspects the container one time. When the container is not running, the testbed waits for the end of its attach and throws the exit error (exit code and output). Else it throws "Container … was not ready", with the error of the strategy as the cause and the output of the container. This closes #4913, and the log strategy needs no rule for the end of the logs other than to reject.
4. **The fixtures wait for the ready line only.**

   | Fixture            | `until`                                                                                         | `timeout` |
   | ------------------ | ----------------------------------------------------------------------------------------------- | --------- |
   | `Postgres`         | `forLogMessage('database system is ready to accept connections', { times: 2 })`                 | 60 s      |
   | `Mysql`, `Mariadb` | `forLogMessage('port: 3306  ')`                                                                 | 90 s      |
   | `SqlServer`        | `forLogMessage('Recovery is complete')`, then `#ping` (and its Full-Text Search check) one time | 180 s     |
   | `ClickHouse`       | `SELECT 1` with `retryUntilReady`: its console gets no ready line                               | 60 s      |

5. **A strategy that only one or two places need stays at those places.** The map of the readiness sites (`~/.claude/plans/readiness-6219/map.md`) counts, after the migration: a polled command 1 (ClickHouse), a line then a one-time check 2 (SQL Server's Full-Text Search, the SSH banner of the mutex tests), an HTTP check 0 (the dind `/_ping` after its `API listen on` line has no job), a health check 0 in this repository (no site sets a Docker `Healthcheck`), a port check 0. Each of them is written at its site as a strategy function, and moves into the package at its third place (the Rule of Three). The fakes of the failure paths (5 sites) are strategy functions as well.
6. **`healthy` goes, with no alias.** Each `healthy` site moves to `wait`. The 6 hand-written loops that wait for readiness move to `forLogMessage` through `serve()`, `reuse()` or `start()`. `waitForLogMessage` and its file go.

## Considered Options

- **`container.followLines()` in `@zukhruf/docker`, and `healthy` stays.** It removes the copies of the line split, but each site still writes its own wait, time limit and end-of-logs rule. With wait strategies, the log strategy is the only user of the line split, so the split stays inside it, as testcontainers keeps it inside its log strategy.
- **The full set of the leaders now** (`forHealthCheck`, `forListeningPorts`, `forHttp`, `forSuccessfulCommand`, `forAll`). Each has 0 to 2 places here. A strategy is written from three working copies, not from a guess.
- **An interface with a `waitUntilReady()` method and builder methods, as the leaders have.** In Node the builders (`withStartupTimeout()`) are the reason for the class. Here the limit belongs to the service (`wait.timeout`), and a function type is the same contract with less to implement.
- **`forAll`, as in testcontainers-go (in order) or node (at the same time).** Each composite here is "a line, then one check", and there are 2 of them. They stay as two `await`s in one strategy function.
- **A query after the ready line, as ADR 0035 decided.** The 2nd Postgres line and the MySQL and MariaDB line with `port: 3306  ` come from the final server, which listens on TCP when it writes them, and testcontainers-go waits for the MySQL line alone (`modules/mysql/mysql.go:62`). The mutation proof found no test that needs the query (M3a, M3b).
- **A Docker `HEALTHCHECK` and the `health_status` event.** The engine polls the check at its interval, so the answer comes no sooner (ADR 0035).

## Consequences

- An acquisition makes one log stream, in place of a stream and a query (Postgres, MySQL, MariaDB).
- The tests of the line split and of the end of the logs are tests of `forLogMessage`, and the exit precedence is a test of the testbed.
- `start()` can wait, so a test that starts a container and needs its first line does not follow the logs by hand.
- `retryUntilReady` stays. It is a public export, and ClickHouse and consumer tests use it.
- Production code waits for its containers in its own way: april waits for the `health_status` event, and finetuning polls an HTTP check. That is 2 places of 2 kinds, so no production strategy moves into `@zukhruf/docker` now.
- Every caller of `healthy` changes: the fixtures, the tests of this package, and the mutex tests. No consumer repository calls `serve()` or `reuse()` with `healthy` (#6140, #6142 wait on this paper for their readiness sites).

## Confirmation

To come with the build: a test of `forLogMessage` for each of the 16 KiB partial frame with a line of the other stream between its parts, a UTF-8 character across two frames, a line before the call, `times`, a container restarted since its first lines, and logs that end before the line; a test of the testbed for a strategy that rejects on a stopped container (#4913) and for the startup time limit; a mutation proof of each.

Sources: testcontainers-node 12.2.2 `build/wait-strategies/log-wait-strategy.js:190-231` (follows one stream of stdout and stderr together, splits it with `byline`, rejects when the stream ends), `health-check-wait-strategy.js:12` (polls `inspect` every 100 ms), `composite-wait-strategy.js:47-82` (`forAll` at the same time), `wait-strategy.js` (60 s default); testcontainers-go v0.45.0 `wait/log.go` (reads the full logs every 100 ms and counts the message in the whole buffer), `wait/all.go` (`ForAll` in order), `wait/wait.go` (`checkTarget`: the exit code, no output).
