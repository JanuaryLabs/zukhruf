# execa starts the process and keeps its output, and the package stops it and reads its lines and messages

Status: Accepted 2026-11-27 (backlog #6077).

Decision-makers: the zukhruf session of backlog #6077 proposes this from the probes of 2026-11-27. Ezz rules on it in the review of the paper.

Node.js 26 has `spawn`, `execFile` and `spawnSync`. Its `ChildProcess` has `Symbol.dispose`, which sends SIGTERM and does not wait (probed on v26.13.1). It has no step from SIGTERM to SIGKILL, no stop of the process group, no end of the child with its parent, no `Symbol.asyncDispose` and no ready wait. Its IPC channel keeps a message that the child sent before the parent listened, and `events.once(child, 'message', { signal })` rejects with the reason of the signal (probed 2026-11-27).

## The candidates

The probes ran each requirement live in an empty folder on 2026-11-27, on Node.js v26.13.1 (backlog #6077). The `@stdlib` scope has no package that starts a process.

|                                                                            | execa 10.2.1                                       | nano-spawn 3.0.0                  | tinyexec 1.4.0      | zx 8.8.5            |
| -------------------------------------------------------------------------- | -------------------------------------------------- | --------------------------------- | ------------------- | ------------------- |
| Weekly downloads                                                           | 231 M                                              | 5.3 M                             | 231 M               | 2.7 M               |
| Installs                                                                   | 18 packages                                        | 1                                 | 1                   | 1                   |
| R1 a run at exit 3 gives the end and the output, no throw                  | yes (`reject: false`, `all`)                       | rejects; the error has them       | no combined output  | yes (`nothrow`)     |
| R2 an abort rejects with its reason                                        | yes (`cause` is the reason)                        | yes (`cause.cause`)               | no: resolves empty  | yes (`cause.cause`) |
| R3 SIGTERM, then SIGKILL after a grace                                     | yes (`forceKillAfterDelay`)                        | no                                | no                  | no                  |
| R4 the stop takes the children                                             | yes (`killDescendants`)                            | by hand                           | by hand             | yes                 |
| R5 the child ends when the parent is killed by SIGKILL                     | no                                                 | no                                | no                  | no                  |
| R6 a ready line, also one before the wait, with stderr at an end before it | the late wait misses it; `break` waits for the end | a late wait throws; `break` waits | no stderr at an end | yes                 |
| R7 a disposal symbol                                                       | no                                                 | no                                | no                  | no                  |
| R8 a message sent before the wait, with a signal                           | misses it; ignores the signal                      | Node.js does it                   | Node.js does it     | no IPC              |

## Decision

- execa starts the process and keeps its output: `reject: false` and `all: true` give the end, `stdout`, `stderr` and `output` of a run. On macOS and Linux it starts the keeper of [ADR 0004](./0004-a-started-process-ends-with-its-parent-also-when-the-parent-is-killed.md), detached, with the lifeline at fd 3, and the keeper's `sh` finds the file on `PATH`. On Windows it starts the file itself: it finds it on `PATH` and starts `.cmd` files, and its `forceKillAfterDelay` and `killDescendants` stop it (open: a Windows CI run probes them before the build). `@zukhruf/coprocess` already depends on execa 10.2.1 ([coprocess ADR 0001](../../../coprocess/docs/adr/0001-the-exit-is-an-event-and-the-package-uses-execa.md)).
- On macOS and Linux, the package stops the process itself: SIGTERM and then SIGKILL to the group of the keeper ([ADR 0005](./0005-a-stop-sends-sigterm-to-the-process-group-and-sigkill-after-a-grace-of-5-seconds.md)). A signal to the keeper alone does not reach the target, so execa's own stop is not used there.
- The package reads stdout lines from the raw stream of the child, not through the iterator of execa, so a `break` returns at once and a late reader gets the lines so far.
- The package reads messages through the IPC channel of Node.js (`child.on('message')`), not through `getOneMessage` of execa.
- The end of the child with its parent (ADR 0004) and `Symbol.asyncDispose` are the package's own, because no candidate has them.

## Considered Options

- **`node:child_process` only.** Coprocess ADR 0001 had this form first and its tests passed. With the keeper, the stop on macOS and Linux is the package's in each option. The package would still write the output in the order written, its buffer limit, the abort, and on Windows the `PATH` lookup, the start of `.cmd` files and the stop of the tree. execa has them.
- **nano-spawn.** No step from SIGTERM to SIGKILL, no stop of the children; coprocess ADR 0001 rejected 2.1.0 for the first, and 3.0.0 still has none.
- **tinyexec.** An abort loses its reason, and an end before a ready line gives no stderr.
- **zx.** It runs each command through a shell, so a Node.js child has no IPC channel, and Node.js 26 warns (DEP0190) at each start.
- **execa for the start and the output (and on Windows the stop), the package for the stop of the group, the lines, the messages, the end with the parent and the disposal.** This option was selected.

## Consequences

- The reasons of testing ADR 0021 against execa for the worker stay true, and this package does not use those parts of execa.
- The package pins execa as coprocess does, and a new major version of execa is probed against this table before the upgrade.
