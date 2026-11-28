# A started process can write to the stdout and stderr of this program, and never reads its stdin

Status: Accepted 2026-11-28 (backlog #6077).

Decision-makers: Ezz, on 2026-11-28. Of "stdout and stderr" and "leave the six sites", he chose "stdout and stderr".

Six programs of zukhruf show the output of a child to the person at the terminal while the child runs: zig cc in the native build of `@zukhruf/sqlite-open`, `npm pack` in the pg-boss citations tool, and in `@zukhruf/nx` the steps of the e2e workspace, the auth generator, the Prisma migration diff and the runner of each `nx test`. Each gives the child `stdio: 'inherit'` of `node:child_process`. `start()` took only `'pipe'`, `'ignore'` or a socket for stdout, and `'pipe'` or `'ignore'` for stderr, so the six could not move to the package (backlog #6155), and their children did not end with a parent that is killed ([ADR 0004](./0004-a-started-process-ends-with-its-parent-also-when-the-parent-is-killed.md)).

## The leaders

| Leader | The child writes where its parent writes      | The child reads what its parent reads | Link                                                                       |
| ------ | --------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------- |
| Go     | `cmd.Stdout = os.Stdout`, `cmd.Stderr = ...`  | `cmd.Stdin = os.Stdin`                | https://pkg.go.dev/os/exec#Cmd                                             |
| Rust   | `Stdio::inherit()`, the default of `status()` | `Stdio::inherit()`                    | https://doc.rust-lang.org/std/process/struct.Stdio.html                    |
| Deno   | `stdout: "inherit"`, `stderr: "inherit"`      | `stdin: "inherit"`                    | https://docs.deno.com/api/deno/~/Deno.CommandOptions                       |
| .NET   | `RedirectStandardOutput = false`, the default | `RedirectStandardInput = false`       | https://learn.microsoft.com/dotnet/api/system.diagnostics.processstartinfo |

Each leader gives all three. By default none of them starts the child in its own session (Go does only when `SysProcAttr.Setsid` is set). The keeper of ADR 0004 does: execa starts it with `detached: true`, which on macOS and Linux is `setsid()`, so the process leads a new session and a new process group (probed 2026-11-28: the session id of the child is its own pid, and that of the parent is another). A terminal is the controlling terminal of one session. A process of another session that reads it reads the same keys that the shell and the foreground job read, and no job control stops it.

## Decision

- `start({ stdout: 'inherit', stderr: 'inherit' })`: the process writes to the stdout and the stderr of this program, as they are, a terminal or a pipe or a file. Each takes `'inherit'` alone or with the other.
- A process whose stdout is `'inherit'` has no lines and no ready line, as one whose stdout is `'ignore'`; the type allows `ready` only with `stdout: 'pipe'`.
- stdin has no `'inherit'`, because the process is in its own session.
- `ended` gives the end, as for any started process. A caller that runs such a process to its end writes `await (await command.start({ stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' })).ended`, as Rust's `status()` is `spawn()` and `wait()`.
- The terminal sends Ctrl-C to its foreground process group, and the process is not in it. A caller that passes the signal on sends it: `started.signal('SIGINT')`. When the caller ends without that, the keeper stops the group (ADR 0004).

## Considered Options

- **Leave the six programs on `node:child_process`.** Their children go on when the parent is killed, and each keeps its own end and its own signal code.
- **`'inherit'` for stdin, stdout and stderr, as the leaders give.** The stdin of another session reads the keys of the shell.
- **`'inherit'` for stdout and stderr.** This option was selected.

## Consequences

- The six programs move to the package, and their children end with them.
- The runner of `nx test` can then start its test process with `'inherit'` and pass SIGINT, SIGTERM and SIGHUP on to it with `signal()` (its move is backlog #6155) ([ADR 0012](./0012-signal-sends-a-signal-to-the-program-alone-and-gives-false-when-the-program-has-ended.md)), as it did to its child before.
- A process that must read the terminal, such as a prompt, is not a started process of this package; that is on the map with a pseudo-terminal.
