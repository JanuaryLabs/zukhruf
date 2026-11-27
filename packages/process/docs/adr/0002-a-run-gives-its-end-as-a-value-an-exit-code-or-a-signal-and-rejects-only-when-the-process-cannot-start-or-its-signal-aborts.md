# A run gives its end as a value, an exit code or a signal, and rejects only when the process cannot start or its signal aborts

Status: Accepted 2026-11-27 (backlog #6077).

Decision-makers: the zukhruf session of backlog #6077 proposes this from the leaders. Ezz rules on it in the review of the paper.

A test that runs a command usually reads the exit code: it checks that a bad input exits with 2, or that a lint finds nothing. `promisify(execFile)` rejects at each non-zero exit, so each such test catches the rejection and reads `code` from it. In the five wrappers of other repositories (ADR 0001), four give the exit code as a value. `@zukhruf/docker` does the same for a container: `DockerTestbed.run` gives an `ExecResult` with `exitCode`, `stdout`, `stderr` and `output`, and does not throw for a non-zero exit code.

A process of this machine can also end by a signal. Then Node.js gives `code` as `null` and `signal` as its name. A type with a number that can be `null` lets a caller compare `null` with `0`.

## The leaders

| Leader  | The end                                                   | A non-zero exit                       | Link                                                                                                   |
| ------- | --------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Go      | `*ExitError`, with `ExitCode()` and `Stderr`              | an error value, not a panic           | https://pkg.go.dev/os/exec                                                                             |
| Python  | `CompletedProcess.returncode`, `-N` for signal N          | a value; `check=True` raises          | https://docs.python.org/3/library/subprocess.html                                                      |
| .NET 11 | `ProcessExitStatus { ExitCode, Signal, Canceled }`        | a value                               | https://learn.microsoft.com/dotnet/api/system.diagnostics.process.runandcapturetextasync?view=net-11.0 |
| Deno    | `CommandOutput { code, success, signal }`                 | a value                               | https://docs.deno.com/api/deno/~/Deno.Command                                                          |
| Rust    | `Output { status }`, `status.code()` or `status.signal()` | a value                               | https://doc.rust-lang.org/std/process/struct.Output.html                                               |
| Bun     | `exitCode`, `signalCode`, `success`                       | a value                               | https://bun.com/docs/runtime/child-process                                                             |
| CliWrap | `ExitCode`, `IsSuccess`                                   | throws, unless `WithValidation(None)` | https://github.com/Tyrrrz/CliWrap                                                                      |
| execa   | `exitCode`, `signal`                                      | throws, unless `reject: false`        | https://github.com/sindresorhus/execa                                                                  |

Six of the eight give the end as a value. The two that throw are libraries, and each has an option to turn it off.

## Decision

- `command.run({ input, signal })` of a `Command` ([ADR 0010](./0010-a-command-says-what-to-run-and-run-and-start-are-its-methods.md)) resolves when the process has ended and its streams have closed. It gives `Completed`: the end and the output.
- The end is `{ exitCode }` or `{ signal }`, never both and never neither. The type says so: `exitCode` is a number where `signal` is absent, and `signal` is a signal name where `exitCode` is absent.
- The output is `stdout`, `stderr`, and `output`, which holds both in the order that the process wrote them. The text is not trimmed, as in `ExecResult` of `@zukhruf/docker`.
- A run rejects in two cases only. When the process cannot start, for example because the file does not exist, it rejects with `StartError`, whose `cause` is the error of the start (`ENOENT`, `EACCES`). When its `signal` aborts, it stops the process ([ADR 0005](./0005-a-stop-sends-sigterm-to-the-process-group-and-sigkill-after-a-grace-of-5-seconds.md)) and rejects with the reason of the signal.
- The package finds the file before the start: on the `PATH` of the given environment when the name has no slash, else at its path, and it must be executable. When it is not there, the run rejects with `StartError` whose `cause` has the code `ENOENT`, and when it is not executable, `EACCES`; nothing starts. This is a check that predicts, not a trial, because the trial cannot tell: under the keeper of [ADR 0004](./0004-a-started-process-ends-with-its-parent-also-when-the-parent-is-killed.md), `sh` always starts, and a failed `exec` ends with 126 or 127, the same codes that a process can give itself (probed 2026-11-27: a missing file gives 126 in bash and 127 in dash). A file that goes away between the check and the start ends with 127.
- `input` is written to stdin, and then stdin ends. Without `input`, stdin ends at once, so a process that reads stdin does not wait.

## Considered Options

- **Reject at a non-zero exit, as `execFile`, nano-spawn and execa do by default.** Each test that reads the exit code then catches. The sweep of ADR 0001 shows that each repository wrote a wrapper to undo it.
- **`exitCode: number | null` with `signal: string | null`**, as `node:child_process` gives them. A caller can read one field and miss the other.
- **A `success` boolean, as Deno and Bun give.** It is `exitCode === 0`, so it is a second field that says the same fact.
- **The end as a value, and a union of an exit code and a signal.** This option was selected.

## Consequences

- A test writes `assert.equal((await command.run()).exitCode, 2)`, with no catch.
- A caller that wants a throw at a non-zero exit checks the end itself. The package has no `check` option, because one line does it and the line says what the caller expects.
- The shape matches `ExecResult` of `@zukhruf/docker` in `exitCode`, `stdout`, `stderr` and `output`. A container has no `signal`, because the engine gives an exit code for each end.
