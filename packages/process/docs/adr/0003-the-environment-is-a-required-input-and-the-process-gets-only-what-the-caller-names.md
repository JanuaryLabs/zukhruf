# The environment is a required input, and the process gets only what the caller names

> **Design for review.**

Status: Proposed 2026-11-27 (backlog #6077).

Decision-makers: the zukhruf session of backlog #6077 proposes this. It differs from every leader, so Ezz rules on it in the review of the paper.

`node:child_process` gives a child the environment of its parent when the caller gives no `env`. Thus a library that starts a process reads `process.env` without a line that says so. Root ADR 0001 gives each package the tag `layer:island`: the package does not read the environment. [Testing ADR 0009](../../../testing/docs/adr/0009-a-test-never-changes-the-environment-of-its-process.md) says that a test never changes the environment of its process, so a test gives the environment of a child as a value. Of the wrappers of ADR 0001, three build an environment for each child (context-compiler `cli` with its own `HOME`, text2sql `agentBacklog` with a clean environment and its own `HOME`, nx `workspace()` with only `PATH`, `HOME`, `NX_DAEMON` and `NX_NO_CLOUD`).

## The leaders

| Leader | No environment given                                            | Link                                                                                   |
| ------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Go     | `Cmd.Env` nil: the environment of the parent                    | https://pkg.go.dev/os/exec                                                             |
| Python | `env=None`: the environment of the parent                       | https://docs.python.org/3/library/subprocess.html                                      |
| .NET   | `ProcessStartInfo.Environment` starts as a copy of the parent's | https://learn.microsoft.com/dotnet/api/system.diagnostics.processstartinfo.environment |
| Deno   | the parent's, with `env` added; `clearEnv` removes the parent's | https://docs.deno.com/api/deno/~/Deno.Command                                          |
| execa  | the parent's, with `env` added (`extendEnv: true`)              | https://github.com/sindresorhus/execa                                                  |

Each leader gives the parent's environment by default. Two of them add the caller's values to it, so a caller cannot see what the process gets.

## Decision

- `env` is a required option of `Process.run`, `Process.start`, `NodeProcess` and `Coprocess`. It is the whole environment of the process.
- The package adds nothing to it and reads nothing of `process.env`. A caller that wants its own environment writes `env: process.env`. A caller that adds a value writes `env: { ...process.env, LOG_LEVEL: 'error' }`.
- A value of `undefined` is left out, as `node:child_process` does.

## Considered Options

- **The parent's environment by default, as the leaders do.** The package then reads the environment without a word at the call site, which `layer:island` forbids. A test that wants a clean `HOME` must know that it gets the parent's `HOME` unless it gives one.
- **The parent's environment plus the caller's values, as execa and coprocess do today.** The caller cannot remove a value of the parent, and cannot see the whole environment at the call site.
- **A required, whole environment.** This option was selected. It costs one property, `env: process.env`, at each call site that wants the parent's.

## Consequences

- `Coprocess` changes: today its `env` adds to the parent's environment (`extendEnv` of execa). After the move, each caller gives the whole environment. Its consumers add `...process.env` where they want it.
- The PATH lookup of the file uses the `PATH` of the given environment, as `node:child_process` does.
