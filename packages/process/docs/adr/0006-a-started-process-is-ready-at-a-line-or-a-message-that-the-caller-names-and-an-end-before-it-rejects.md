# A started process is ready at a line or a message that the caller names, and an end before it rejects

Status: Accepted 2026-11-27 (backlog #6077).

Changed in part on 2026-11-27 (backlog #6077, Ezz): the error is `ProcessEndedError`, one class for each wait that the end of the process cuts, as the `TargetClosedError` of Playwright is. A start rejects with `<name> ended (<end>) before it was ready`, and `next()` of a `NodeProcess` with `<name> ended (<end>) before it sent '<type>'` (or `a selected message`). The call site already says which wait it was, so a second class would tell the caller nothing more. No consumer used `EndedBeforeReadyError`.

Decision-makers: the zukhruf session of backlog #6077 proposes this from the leaders. Ezz rules on it in the review of the paper.

A test that starts a server, an owner of a lock or a helper must wait until the process can work. The hand-written waits read stdout until a line such as `holding` or `listening` (`startOwner` of sqlite-snapshot and sqlite-data-version, `connection.test.ts` of docker), or wait for an IPC message (`startWorker`, `startOwner` of ssh). The copies differ in what they do when the process ends first: `startOwner` of sqlite-snapshot throws "The owner ended before it held the database" with no stderr, because its stderr is inherited. A wait with no limit of its own ends only at the time limit of the test.

The probes of 2026-11-27 found two traps in the libraries. A `for await` loop over the lines of execa or nano-spawn that stops at the ready line with `break` waits until the process ends: the `finally` of execa's iterator awaits the process (`lib/convert/iterable.js`). A wait that starts after the line came misses it in execa, and throws in nano-spawn ("must be iterated right away").

## The leaders

No standard library of a language has a ready wait. Testcontainers has it for a container:

| Leader                                      | Ready                                                                                                                                                     | An end before ready                                                                    | Link                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Testcontainers Java                         | `waitingFor(Wait.forLogMessage(regex, times))`, also a listening port, HTTP, a health check; `start()` returns when ready, with a startup timeout of 60 s | `ContainerLaunchException` with "Container exited with code N"                         | https://java.testcontainers.org/features/startup_and_waits/                   |
| Testcontainers Go                           | `wait.ForLog`, `ForListeningPort`, `ForHTTP`, `ForExit`; `WithStartupTimeout`                                                                             | "container exited with code N"                                                         | https://github.com/testcontainers/testcontainers-go/blob/v0.40.0/wait/wait.go |
| `DockerTestbed.serve` of `@zukhruf/testing` | `healthy(service, signal)`, a function that throws until ready                                                                                            | "Container … exited with code … before it was ready", with the output of the container | `packages/testing/README.md`                                                  |
| zx 8.8.5                                    | a loop over stdout lines; a late loop replays the lines so far                                                                                            | rejects with the stderr                                                                | probe of 2026-11-27                                                           |

## Decision

- `Command#start` takes `ready`. `{ line }` is a string that a whole line of stdout equals, or a regular expression that a line matches. A `NodeProcess` also takes `{ message }`, a type or a function of the message ([ADR 0007](./0007-json-lines-and-messages-are-views-of-a-started-process-and-only-a-node-process-has-messages.md)).
- `Command#start` resolves when the process is ready, or at once after the start when the caller gives no `ready`.
- When the process ends before it is ready, `Command#start` rejects with `EndedBeforeReadyError`. It holds the end and the stderr tail, and its message names the process and the end, not the command line.
- When the `signal` aborts before ready, the process is stopped, and `Command#start` rejects with the reason of the signal. The wait has no time limit of its own: the caller's signal is its limit, as `zukhruf/no-own-wait-limit` asks of tests.
- The lines of stdout before and at the ready line stay readable on the started process, so a line that came before a later wait is not lost.

## Considered Options

- **A wait method that the caller calls after the start**, as `next()` of `startWorker`. Between the start and the call, a line can come, and each copy must keep it. A caller can also forget the wait and use a process that is not ready.
- **A listening port and HTTP now**, as Testcontainers has (a listening port is its default). No copy in zukhruf waits for a port of a process: the `sshd.ts` copies listen on their own port and start `sshd -i` for each connection, and the port waits of zukhruf are for containers, which `DockerTestbed.serve` covers. Two copies in other repositories wait for a port or for HTTP: `waitForListeningOrExit` of text2sql (`tools/vscode-playground/src/process-manager.ts`) and `ambient` of context-compiler (`/health`). They are on the map as later, and a third copy moves them in.
- **A time limit of 60 s, as Testcontainers has.** Two limits that do not nest made backlog #4205; the test's signal is the one limit.
- **`ready` at the start, a line or a message, an end before it as a typed error.** This option was selected.

## Consequences

- The copies of `startOwner`, the ready waits of `sshd.ts` and the `listening` waits of docker go.
- `EndedBeforeReadyError` is an error class because the caller's next step differs: it reads the stderr of the process, not its own code.
