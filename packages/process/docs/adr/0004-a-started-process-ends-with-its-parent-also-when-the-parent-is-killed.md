# A started process ends with its parent, also when the parent is killed

Status: Accepted 2026-11-27 (backlog #6077).

Changed in part on 2026-11-27 (backlog #6161): the job object for Windows is deferred work with its proof, as #2753 is for `@zukhruf/docker`.

Changed in part on 2026-11-27 (backlog #6077, unit 3): the pid of a started process is the pid of the program, as Node.js, execa, Go, .NET and Rust give it, not the pid of the keeper. A signal to the keeper pid does not reach the program, and a signal to the group stops the keeper too, so the end does not settle until a SIGCONT (probed). The keeper of `start()` makes its last exec through a new `sh` that writes its own pid on fd 4 and then becomes the program; it costs one more exec of `sh`. `run()` keeps the keeper as written. The parent builds the readers of stdout and stderr in the tick of the spawn, because Node.js drops the output of a child that exits before its streams have a reader.

Decision-makers: the zukhruf session of backlog #6077 proposes this from two probes of 2026-11-27. Ezz rules on it in the review of the paper.

A test process that its runner kills (a timeout with `--test-force-exit`, Ctrl-C, an out-of-memory kill) runs no cleanup. A process that it started keeps running: an owner keeps its exclusive lock on a database, an `sshd` keeps its port, a helper keeps its model in memory. Backlog #4503 saw the same in shipped code: an `ssh … docker system dial-stdio` stayed under launchd after its owner died. `startWorker` solves it for Node.js source only: the child reads its stdin and exits at its end, because the OS closes the pipe when the parent dies. A command that is not Node.js source, or that needs its stdin, has no such way.

## The leaders

| Leader                                                   | The end with the parent                                                                     | macOS |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----- |
| .NET 11                                                  | `ProcessStartInfo.KillOnParentExit`: a job object on Windows, `PR_SET_PDEATHSIG` on Linux   | no    |
| Go                                                       | `SysProcAttr.Pdeathsig`, Linux only, sent at the end of the thread that started the child   | no    |
| Python, Deno, Rust, Bun, execa, nano-spawn, tinyexec, zx | none; execa's `cleanup` runs on a signal that the parent can catch, not on SIGKILL (probed) | no    |

No leader does it on macOS. Node.js has no hook that runs in the child before `exec`, so `PR_SET_PDEATHSIG` cannot be set from Node.js on Linux either.

## The probes

A keeper is a small process between the parent and the target. The parent gives it a lifeline: a pipe at fd 3 that the parent never writes. When the parent ends in any way, the OS closes the pipe, the keeper reads its end, and the keeper stops the target. Two keepers were probed on 2026-11-27 (load averages 55 to 100, so the times are high):

|                                                                         | A keeper in Node.js           | A keeper in POSIX `sh`                                     |
| ----------------------------------------------------------------------- | ----------------------------- | ---------------------------------------------------------- |
| The parent killed with SIGKILL: the target and its child are gone after | 5 to 35 ms (10 runs)          | 3 to 19 ms (20 runs, four shells)                          |
| No keeper (the baseline)                                                | the target and its child stay |                                                            |
| The time to the target's first line (direct: median 3.5 ms)             | median 31 to 66 ms            | median 8 to 10 ms                                          |
| Memory while it waits                                                   | 54 MB                         | 2.3 MB (dash) to 4.2 MB (bash)                             |
| stdin and stdout pass through, `cat` sees its end                       | yes                           | yes                                                        |
| An exit code and a signal of the target reach the parent                | yes                           | yes, see the consequences                                  |
| An IPC channel passes through to a Node.js target                       | yes                           | yes, at fd 4 with `NODE_CHANNEL_FD=4`                      |
| Shells                                                                  |                               | macOS `/bin/sh` (bash 3.2), dash, zsh, busybox ash (Linux) |

## Decision

- On macOS and Linux, each process of `Command#run`, `Command#start`, `Coprocess` and `NodeProcess` starts under a keeper in POSIX `sh`, a file of this package. The parent starts the keeper detached, so the keeper leads its own process group, and gives it the lifeline at fd 3. The target runs in the foreground of that group, with fd 3 closed, so it keeps its stdin and its signals.
- A watcher in the keeper reads fd 3. At its end, it sends SIGTERM to the group, and SIGKILL to the group after the grace of [ADR 0005](./0005-a-stop-sends-sigterm-to-the-process-group-and-sigkill-after-a-grace-of-5-seconds.md).
- The keeper ends as the target ended: the same exit code, or the same signal.
- The keeper refuses to start (exit code 126) when it does not lead its group, so that a signal to its group never reaches the group of the parent.
- A stop of this package sends its signals to the group of the keeper, never to the keeper alone: the shell waits on the target in the foreground and runs a trap only after the target ends.
- `NodeProcess` starts under the keeper too, and its stdin is free. The stdin trick of `startWorker` goes.
- On Windows there is no keeper yet. A job object, as .NET 11 uses, is on the map as later. Until then, a started process on Windows does not end with a parent that is killed, and the README says so.

## Considered Options

- **No end with the parent.** The probe's baseline: the target and its child stay after the parent's SIGKILL.
- **The stdin trick of `startWorker`.** It works only for Node.js source that this package writes, and it takes the stdin of the process.
- **A keeper in Node.js.** It works, and it costs 54 MB and a start of Node.js for each process.
- **`set -m` in the keeper, for a process group of its own.** It works only in bash; dash and ash turn job control off without a terminal, and zsh refuses the option (probed).
- **`setsid`.** macOS has no `setsid` command, and it does not undo the ignored SIGINT of a background command.
- **A keeper in POSIX `sh` that leads its group.** This option was selected.

## Consequences

- Each start costs about 5 ms more and 2 to 4 MB while the process runs.
- `sh` cannot tell an exit code above 128 from a signal: a target that exits with 130 reaches the parent as SIGINT. A command that uses such exit codes on purpose is rare; the README names it.
- A child of the target that leaves the group (`setsid`, `detached: true`) does not end with it.
- The keeper runs `/bin/sh` by its absolute path, never `$SHELL`. zsh reads `~/.zshenv` also for `zsh -c`: a probe of 2026-11-27 saw `zsh -c` give its child the user's `HOME`, `PATH` and an API key from that file, which [ADR 0003](./0003-the-environment-is-a-required-input-and-the-process-gets-only-what-the-caller-names.md) forbids.
- Through the keeper, a file that cannot start ends with 126 or 127, as a process can end by itself. Thus the package finds the file before the start ([ADR 0002](./0002-a-run-gives-its-end-as-a-value-an-exit-code-or-a-signal-and-rejects-only-when-the-process-cannot-start-or-its-signal-aborts.md)).
- A keeper that something outside kills with SIGKILL leaves its target running, as the target would without a keeper.
- The traps of the probe are in the source as tests: `kill -SIG -N` is the only form of a group signal that bash, dash, zsh and busybox read the same way; the shell's own notices ("Killed: 9") go to `/dev/null`, not to the target's stderr; Node.js removes `NODE_CHANNEL_FD` from the environment of its process at its start.

## Confirmation

- The probes of 2026-11-27 (backlog #6077), with the table above. The keeper in POSIX `sh` is 16 lines.
- Each claim of the table becomes a test of the package: the end after a SIGKILL of the parent (a child process of the test that starts a target and is then killed), the passthrough of stdin, the end mirrored, the IPC channel, and each of the four shells where CI has it.
