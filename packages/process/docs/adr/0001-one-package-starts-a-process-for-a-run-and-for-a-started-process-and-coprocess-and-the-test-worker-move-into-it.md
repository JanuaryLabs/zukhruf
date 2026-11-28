# One package starts a process, for a run and for a started process, and the coprocess and the test worker move into it

Status: Accepted 2026-11-27 (backlog #6077).

Decision-makers: Ezz, on 2026-11-27. Asked where the process primitive lives, he chose "Converge": a new package of the base layer, into which `@zukhruf/coprocess` and the worker of `@zukhruf/testing/process` move. Asked whether a run to completion moves in too, he chose "Yes, move it".

In zukhruf, three places start processes, and each does a part of the work:

- `@zukhruf/coprocess` keeps a long-lived process, talks to it in JSON lines, gives its exit as an event, and stops it with SIGTERM and then SIGKILL (its [ADR 0001](https://github.com/JanuaryLabs/zukhruf/blob/aeff1050/packages/coprocess/docs/adr/0001-the-exit-is-an-event-and-the-package-uses-execa.md)).
- `startWorker` of `@zukhruf/testing/process` runs Node.js source with an IPC channel, waits for a message, and ends the child when the test process ends, also by SIGKILL ([testing ADR 0021](../../../testing/docs/adr/0021-a-test-helper-in-the-test-support-of-three-packages-goes-into-an-area-when-no-public-package-does-its-work.md)). It runs only Node.js source, it ignores stdout, and it takes no `cwd` and no `env`. 20 test files use it.
- About 25 places of shipped code call `node:child_process` themselves (git-hooks 6, nx 5, ssh 2, tcc 2, mteb, sqlite-open, the tools).

The tests of the active repositories do the same work by hand. A sweep of their test files on 2026-11-27 found a run to completion that keeps its exit code and output in 224 files of 14 repositories, and a start that waits until the process is ready in 61 files of 9 repositories. Five repositories have their own wrapper: `runNode` of `@sdk-it/testing`, `cli` and `started` of context-compiler, `run` and `agentBacklog` of text2sql, `collectOutput` and `runBin` of deepagents, `shell` of elt. Each wrapper makes its own choices for the same questions: a throw or a value at a non-zero exit, SIGKILL or SIGTERM, a time limit, the stderr in the error.

## The leaders

Each standard library starts every process through one type. A run to completion is a method of that type, and a long-lived process that the parent talks to over its pipes is the same type with piped stdio. No leader has a separate type for a coprocess.

| Leader  | One type for each process    | A run to completion                       | Link                                                                                                   |
| ------- | ---------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Go      | `exec.Cmd`                   | `Output`, `CombinedOutput`                | https://pkg.go.dev/os/exec                                                                             |
| Python  | `subprocess.Popen`           | `subprocess.run` gives `CompletedProcess` | https://docs.python.org/3/library/subprocess.html                                                      |
| .NET 11 | `System.Diagnostics.Process` | `Process.RunAndCaptureTextAsync`          | https://learn.microsoft.com/dotnet/api/system.diagnostics.process.runandcapturetextasync?view=net-11.0 |
| Deno    | `Deno.Command`               | `output()`                                | https://docs.deno.com/api/deno/~/Deno.Command                                                          |
| Rust    | `std::process::Command`      | `output()`                                | https://doc.rust-lang.org/std/process/struct.Command.html                                              |

Readiness is not in any of them. Testcontainers has it, one layer up, as wait strategies of a container ([ADR 0006](./0006-a-started-process-is-ready-at-a-line-or-a-message-that-the-caller-names-and-an-end-before-it-rejects.md)).

## Decision

1. `@zukhruf/process` is a package of the base layer (`std:base`, `layer:island`). It imports execa and `@zukhruf/async` ([ADR 0008](./0008-execa-starts-the-process-and-keeps-its-output-and-the-package-stops-it-and-reads-its-lines-and-messages.md)), and no other zukhruf package. Thus shipped code can use it, and the tests of `docker`, `fs` and `ssh` can use it too. The tests of `async` cannot, because the package imports `async`.
2. `Command#run` runs a process to its end, and `Command#start` gives a started process. `Coprocess` and `NodeProcess` are views of a started process ([ADR 0007](./0007-json-lines-and-messages-are-views-of-a-started-process-and-only-a-node-process-has-messages.md)).
3. `@zukhruf/coprocess` moves into this package and goes away with no alias. Its decisions stay: the exit is an event, SIGTERM and then SIGKILL, the error names the process and holds the end of stderr but not the command line.
4. `@zukhruf/testing/process` moves into this package as `NodeProcess`, and the area goes away with no alias.
5. Each place that calls `node:child_process` for one of these jobs moves to this package, in shipped code and in tests.

## Considered Options

- **Each place calls `node:child_process` or execa itself.** This is the choice of backlog #5488 (2026-11-24): each site of `@zukhruf/testing` calls `promisify(execFile)` and no wrapper is written ("I don't want to rebuild nano-spawn"). This ADR reverses it. The sweep shows that the wrapper comes back in each repository, with its own choices, because `execFile` rejects at a non-zero exit and a test reads the exit code. This package does not rebuild nano-spawn: execa does the start and the stop ([ADR 0008](./0008-execa-starts-the-process-and-keeps-its-output-and-the-package-stops-it-and-reads-its-lines-and-messages.md)).
- **`@zukhruf/coprocess` grows to do the other jobs.** Its name and its glossary say one thing: a long-lived process that the parent talks to over stdin and stdout. A run to completion and a ready wait are not a coprocess, and no leader names its process type after a coprocess.
- **An area of `@zukhruf/testing`.** It is a tool package, so shipped code cannot import it. It depends on `async`, `docker`, `fs` and `ssh`, so their tests cannot import it either (root ADR 0001).
- **execa alone.** It does not end the process with its parent, it has no disposal, its line iterator waits for the end of the process at a `break`, and its message wait misses a message that the child sent before the call ([ADR 0008](./0008-execa-starts-the-process-and-keeps-its-output-and-the-package-stops-it-and-reads-its-lines-and-messages.md)). Each consumer would write these parts again.
- **One package for each job.** The leaders keep them in one type. A run and a started process share the start, the environment, the stop and the end.
- **One base package that converges the three.** This option was selected.

## Consequences

- The base row of root ADR 0001 gets `process`. `coprocess` leaves it. The tool row keeps `testing`, without its `./process` export.
- Testing ADR 0021 is superseded in part: the worker of the mutex tests is `NodeProcess` of this package. Its reasons against execa for the messages stay, and this package follows them.
- Coprocess ADR 0001 moves here as a part of ADRs 0005 and 0008, and the coprocess package is deprecated on npm with a pointer to this package.
- Consumers move after the release: elt (`VisionWorker`, `TranscriptionWorker`), `@zukhruf/pool` (its `Worker` docs), the tests of mutex, single-flight and election (`startWorker`), the shipped sites above, and the wrappers of sdk-it, context-compiler, text2sql, deepagents and elt. Each repository gets one migration item.

## Confirmation

- The sweep of 2026-11-27 (backlog #6077): test files of 14 active repositories, regex detectors, spot checks 5 of 5 (a run) and 4 of 5 (a start).
- The inventory of wrappers in the other repositories (2026-11-27), with three claims checked in the source: `runNode` in `packages/testing/src/index.ts` of sdk-it (17 files use it), `started` in `apps/cli/src/cli.e2e.test.ts` of context-compiler, `killGracefully` in `tools/vscode-playground/src/process-manager.ts` of text2sql.
- The .NET 11 pages of `Process.RunAndCaptureTextAsync` and `ProcessStartInfo.KillOnParentExit` exist (read 2026-11-27).
