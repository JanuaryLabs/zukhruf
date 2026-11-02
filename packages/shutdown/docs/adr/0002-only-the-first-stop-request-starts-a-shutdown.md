# Only the first stop request starts a shutdown

A shutdown can fail to end. For example, a source can wait in a read from a pipe that no program writes. The read waits in the thread pool of Node.js, and no signal stops it (context-compiler #2234). Then the user, or the supervisor, must be able to end the process.

The supervisors already set a deadline: Docker sends SIGKILL after 10 s, Kubernetes after 30 s, systemd after 90 s and Nx after 5 s. In a terminal, the user presses Ctrl-C again.

A probe on Node.js 26.10.0 ran a process that removed its listener at the first SIGINT, while its work waited in such a read. The first SIGINT aborted the work, and the process lived on. The second SIGINT ended it by SIGINT. Go documents the same rule for `NotifyContext`: after `stop()`, "a second ctrl-C will terminate the program". The SIGINT watcher of Playwright says: "We remove the handler so that second Ctrl+C immediately kills the process via the default sigint handler. This is handy in the case where our shutdown takes a lot of time or is buggy."

## Considered Options

- **Ignore a second signal**, as `next start`, the task runner of Nx and the .NET Generic Host do. Nx keeps its listener so that it takes the signal that `signal-exit` re-raises. Next.js ignores a second SIGINT, because a shell can send one Ctrl-C to each process of the job. Then a shutdown that does not end needs SIGKILL from another terminal.
- **A timer of the package**, as `close-with-grace` (10 s) and the .NET Generic Host (`ShutdownTimeout`, 30 s) have. The supervisor already owns this deadline, and two deadlines can disagree. Go and tokio have no timer.
- **Remove each listener of the package at the first stop request.** This option was selected.

## Consequences

- The first termination signal removes the termination signal listeners of the package. The first crash removes the termination signal and crash listeners. The `'exit'` listener stays.
- A second termination signal gets the default action, and a second crash gets the default of Node.js. A termination signal during the cleanup of a crash also ends the process at once.
- The exit status follows the cause, not the later stop request. A crash during the cleanup of a SIGINT shutdown ends the process at once, and the process dies by SIGINT ([ADR 0001](./0001-the-process-dies-by-its-termination-signal-after-the-cleanup.md)). For example, work that rejects with the `AbortError` of the signal, and that no code catches, does not change an interrupt into a failure.
- For this case, the crash listeners stay after a termination signal. The default of Node.js cannot end the process by the signal and also write the error: with no listener, Node.js emits `'exit'` before it writes the error (`lib/internal/process/execution.js:192-204` of Node.js 26.10.0), and the death by the signal at `'exit'` comes first. A test without the listener saw the process die by SIGINT with nothing on standard error. Thus the listener writes the error, and then it ends the process by the signal.
- SIGINT, SIGTERM and SIGHUP start a shutdown, as the task runner of Nx and `signal-exit` do. SIGHUP comes when the terminal closes. Without a listener, a program that writes SQLite ends in the middle of a write, and a hot journal can stay. SIGQUIT keeps its default action, because Ctrl-\ asks for a core dump.
- A listener for SIGHUP replaces the ignore of `nohup`: a probe showed that the listener of Node.js runs when the parent ignored SIGHUP. Go documents the same for `signal.Notify`. A program that must live on after its terminal closes runs under a supervisor or in tmux.
