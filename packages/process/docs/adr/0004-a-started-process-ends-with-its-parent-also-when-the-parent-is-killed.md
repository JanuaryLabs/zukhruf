# A started process ends with its parent, also when the parent is killed

Status: Accepted 2026-11-27 (backlog #6077).

Changed in part on 2026-11-27 (backlog #6161): the job object for Windows is deferred work with its proof, as #2753 is for `@zukhruf/docker`.

Superseded on 2026-11-27 by the keeper B'' paragraph below, which drops the pid report: changed in part on 2026-11-27 (backlog #6077, unit 3): the pid of a started process is the pid of the program, as Node.js, execa, Go, .NET and Rust give it, not the pid of the keeper. A signal to the keeper pid does not reach the program, and a signal to the group stops the keeper too, so the end does not settle until a SIGCONT (probed). The keeper of `start()` makes its last exec through a new `sh` that writes its own pid on fd 4 and then becomes the program; it costs one more exec of `sh`. `run()` keeps the keeper as written. The parent builds the readers of stdout and stderr in the tick of the spawn, because Node.js drops the output of a child that exits before its streams have a reader. So fd 4 of a start carries the pid, and the IPC channel of a Node.js target moves to fd 5 (`NODE_CHANNEL_FD=5`, the channel that `ipc: true` of execa adds after the given stdio); the watcher closes fd 4 and fd 5.

Changed in part on 2026-11-27 (backlog #6077, keeper B'', built): the keeper starts the watcher and then execs the program, one text for `run()` and `start()`. The program leads the group with the pid of the keeper, so `pid` is `subprocess.pid`: the pid report on fd 4, `REPORTING_KEEPER` and its second exec of `sh` go, and the IPC channel of a Node.js program is fd 4 in a run and in a start. The watcher ignores SIGTERM, so a stop leaves it running. At the end of the lifeline it exits when the program is gone (`kill -0 $$` fails), and else it sends SIGTERM to the group, sleeps the grace and sends SIGKILL. The parent closes its end of the lifeline when the program exits, so the watcher exits then and the group empties. The keeper before it (the program in the foreground of a waiting `sh`) kept fd 5 open in the shell, so a `process.disconnect()` of the program never reached the parent. The probe of 2026-11-27 (bash 3.2 as `/bin/sh`, dash, zsh, busybox ash): a stop empties the group in 1 to 5 ms; the parent killed with SIGKILL and no stop: the program and its child are gone in 5 to 10 ms; execa settles 0 to 1 ms after the exit; the exit codes 0, 3 and 130 and the signals SIGTERM and SIGKILL reach the parent as themselves; a disconnect reaches the parent; the median start is unchanged. A program that ignores SIGTERM, whose parent is killed with SIGKILL during a stop, ends at the grace: 2005 ms after the parent's death with a grace of 2 s on busybox ash, and at the grace in the test of the package on macOS (the macOS rows of the probe ended earlier, at the end of the program's stdin). The variant whose watcher ended at the stop's SIGTERM (B') left that program running. ~~New consequence: the watcher is a child of the program and a member of its group until the program ends.~~ Superseded on 2026-11-28 by the double fork below.

Changed in part on 2026-11-28 (backlog #6077, keeper B''', built): the keeper starts the watcher through a double fork, `( ( watcher ) & )`, and then execs the program. The subshell that forks the watcher exits at once, so the watcher is a child of init (or of a subreaper), not of the program, and it stays in the group of the program. Under B'' a program that waits for all its children (`waitpid(-1)` until ECHILD, `os.wait()` of Python until `ChildProcessError`, a supervisor that ends with its last child, the monitor of `sshd -i`) never ended: the watcher, its child, ends only after it. In the nested subshells `$$` still names the keeper shell, which is the program after the exec (checked on each shell). The probe of 2026-11-28 (bash 3.2 as `/bin/sh`, dash, zsh on macOS; busybox ash in `node:26-alpine`): a Perl and a Python program that fork a short child and then wait for all their children end in 7 to 42 ms (under B'' both waited until killed); the parent pid of the watcher is 1 and its group is the group of the program; a stop empties the group in 2 to 4 ms; a program that ignores SIGTERM, whose parent is killed with SIGKILL during a stop, ends 2004 to 2021 ms after the parent's death with a grace of 2 s, after it got the SIGTERM of the stop and the SIGTERM of the watcher; the parent killed with SIGKILL and no stop: the program and its child are gone in 5 to 46 ms; execa settles 0 to 1 ms after the exit; the ends 0, 3, 130, SIGTERM and SIGKILL read as themselves; a disconnect reaches the parent; the median start is 0.2 to 1.2 ms slower (one more fork).

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

- On macOS and Linux, each process of `Command#run`, `Command#start`, `Coprocess` and `NodeProcess` starts under a keeper in POSIX `sh`, a file of this package. The parent starts the keeper detached, so the keeper leads its own process group, and gives it the lifeline at fd 3. The keeper starts the watcher and then execs the target, with fd 3 closed, so the target leads the group with the pid of the keeper and keeps its stdin and its signals.
- The watcher reads fd 3. It starts through a double fork, so it is in the group of the target but not its child. It ignores SIGTERM, so a stop leaves it running. At the end of fd 3 it exits when the target is gone; else it sends SIGTERM to the group, and SIGKILL to the group after the grace of [ADR 0005](./0005-a-stop-sends-sigterm-to-the-process-group-and-sigkill-after-a-grace-of-5-seconds.md). The parent closes its end of fd 3 when the target exits, so the watcher leaves then.
- The target is the keeper after the exec, so its end reaches the parent as itself: the same exit code, or the same signal.
- The keeper refuses to start (exit code 126) when it does not lead its group, so that a signal to its group never reaches the group of the parent.
- A stop of this package sends its signals to the group of the target, never to the target alone: a signal to the target alone does not reach its children.
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
- Closed on 2026-11-27 (keeper B''): ~~`sh` cannot tell an exit code above 128 from a signal: a target that exits with 130 reaches the parent as SIGINT.~~ The keeper execs the program, so an exit code of 130 is `{ exitCode: 130 }`.
- A child of the target that leaves the group (`setsid`, `detached: true`) does not end with it.
- The keeper runs `/bin/sh` by its absolute path, never `$SHELL`. zsh reads `~/.zshenv` also for `zsh -c`: a probe of 2026-11-27 saw `zsh -c` give its child the user's `HOME`, `PATH` and an API key from that file, which [ADR 0003](./0003-the-environment-is-a-required-input-and-the-process-gets-only-what-the-caller-names.md) forbids.
- Through the keeper, a file that cannot start ends with 126 or 127, as a process can end by itself. Thus the package finds the file before the start ([ADR 0002](./0002-a-run-gives-its-end-as-a-value-an-exit-code-or-a-signal-and-rejects-only-when-the-process-cannot-start-or-its-signal-aborts.md)).
- After the exec no keeper stands between the parent and the target: a signal from outside to the target reaches the target itself. A watcher that something outside kills with SIGKILL leaves its target running, and the target then does not end with its parent, as without a keeper.
- The watcher is in the group of the target but is not its child, so a target that waits for all its children does not wait for the watcher. A target that sends SIGKILL to its own group kills the watcher too; for that target the end with the parent ends there.
- A child that a target leaves in the group when the target exits by itself stays running, as before: the watcher exits at the end of fd 3 when the target is gone, and does not signal the group.
- The parent closes fd 3 in its event loop at the exit of the target. A blocked loop only delays the end of the watcher, never the end of the target.
- The traps of the probe are in the source as tests: `kill -SIG -N` is the only form of a group signal that bash, dash, zsh and busybox read the same way; the shell's own notices ("Killed: 9") go to `/dev/null`, not to the target's stderr; Node.js removes `NODE_CHANNEL_FD` from the environment of its process at its start.

## Confirmation

- The probes of 2026-11-27 (backlog #6077), with the table above. The keeper in POSIX `sh` is 16 lines.
- Each claim of the table becomes a test of the package: the end after a SIGKILL of the parent (a child process of the test that starts a target and is then killed), the passthrough of stdin, the end mirrored, the IPC channel, and each of the four shells where CI has it.
