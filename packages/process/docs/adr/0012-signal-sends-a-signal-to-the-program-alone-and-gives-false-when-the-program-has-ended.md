# signal sends a signal to the program alone, and gives false when the program has ended

Status: Accepted 2026-11-28 (backlog #6077).

Decision-makers: Ezz, on 2026-11-28. Asked whether to add `started.signal(name)`, he answered "learn from top leaders", so the session decided it from the probes of the leaders below.

A started process had `stop()`, which sends SIGTERM and then SIGKILL to the whole process group ([ADR 0005](./0005-a-stop-sends-sigterm-to-the-process-group-and-sigkill-after-a-grace-of-5-seconds.md)). Other signals had no method. The move of backlog #6155 found callers that need one: tests freeze a process with SIGSTOP and wake it with SIGCONT, crash it with SIGKILL, and the runner of `nx test` passes SIGINT, SIGTERM and SIGHUP on to its test process. They called `process.kill(started.pid, name)`. That throws ESRCH when the program has ended, so a `finally` that wakes a frozen process hid the real error of the test (single-flight `failover.test.ts`). And once the system has reaped the program, it can give the pid to another process, which then gets the signal.

## The leaders

Each was probed on 2026-11-28 with a program that had already ended and been reaped:

| Leader    | The call                    | What it signals | After the end                                  | Link                                                                           |
| --------- | --------------------------- | --------------- | ---------------------------------------------- | ------------------------------------------------------------------------------ |
| Node 26   | `child.kill(signal)`        | the child       | returns `false`                                | https://nodejs.org/api/child_process.html#subprocesskillsignal                 |
| Python 3  | `Popen.send_signal(sig)`    | the child       | does nothing                                   | https://docs.python.org/3/library/subprocess.html#subprocess.Popen.send_signal |
| Rust 1.99 | `Child::kill()`             | the child       | `Ok(())` (SIGKILL only)                        | https://doc.rust-lang.org/std/process/struct.Child.html#method.kill            |
| Go 1.24   | `Process.Signal(sig)`       | the process     | the error value `os: process already finished` | https://pkg.go.dev/os#Process.Signal                                           |
| Deno 2.9  | `ChildProcess.kill(signal)` | the child       | throws `TypeError`                             | https://docs.deno.com/api/deno/~/Deno.ChildProcess.prototype.kill              |

Each leader signals the one process, never its group, and none signals a pid that the system reaped. Four of the five give the end as a value or as nothing, and one throws.

## Decision

- `started.signal(name)` sends the signal `name` to the program alone. Its group is the job of `stop()`.
- It gives `true` when it sent the signal, and `false` when the program has ended. It never throws for an end, as Node.js gives `false` and Python does nothing.
- It sends through `kill()` of the Node.js child, which knows when Node.js reaped the program, so a pid that the system gave to another process gets nothing. It does not use the `kill()` of execa, which starts a timer for SIGKILL after a SIGTERM.
- The name is Go's, as the other names of the package are ([ADR 0009](./0009-the-name-is-process-after-the-process-type-of-dotnet-and-rust.md)). `kill`, the name of Node.js, Deno and Rust, says more than a signal does: SIGCONT and SIGUSR1 kill nothing.

## Considered Options

- **`process.kill(started.pid, name)` at each caller.** It throws ESRCH after the end, and it can reach a reused pid.
- **A method that fails after the end: Deno throws, and Go gives an error value.** Each caller then handles the end, as it handled ESRCH.
- **A method that gives false after the end, as Node.js.** This option was selected.

## Consequences

- A test wakes a frozen program in a `finally` with `started.signal('SIGCONT')`, and the real error of the test stays the error.
- The runner of `nx test` passes on SIGINT with `started.signal('SIGINT')`.
- A caller that must know the signal arrived reads the result; a caller that does not care reads nothing.
