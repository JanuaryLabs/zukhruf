# Shutdown

A graceful shutdown for a Node.js process. A stop request aborts a signal, the program stops its work and runs its cleanup, and the process ends by the cause. The package owns no policy: what the work is, and how long the supervisor waits, stay with the program and its supervisor. Signal and cancel have the meanings that [the async glossary](../async/CONTEXT.md) gives them.

## Language

**Shutdown**:
The stop of a process after a stop request. The work stops at the signal, the cleanup runs, and the process ends by the cause.
_Avoid_: Exit (only the last step), termination (the kernel ends a process), teardown (a test has a teardown)

**Stop request**:
An event that starts a shutdown: a termination signal or a crash. Only the first stop request starts the shutdown. A later one ends the process at once, by the cause.
_Avoid_: Interrupt (SIGINT only), cancel (a caller cancels its own wait)

**Termination signal**:
A POSIX signal that asks a process to stop: SIGINT (Ctrl-C), SIGTERM (Docker, Kubernetes, systemd) and SIGHUP (the terminal closes). SIGQUIT is not one here: its default action writes a core dump.
_Avoid_: Signal alone (in zukhruf, a signal is an `AbortSignal`), OS signal

**Crash**:
An exception that no code catches (`'uncaughtException'`), or a rejection that no code handles (`'unhandledRejection'`).
_Avoid_: Error alone (most errors are caught), fatal error

**Signal**:
The `AbortSignal` of a `Shutdown`. It aborts at the first stop request, or when the scope of the `Shutdown` ends.
_Avoid_: Token (Go and .NET use context and cancellation token for the same thing)

**Cause**:
The first stop request, as the reason of the signal gives it: a `DOMException` with the name `AbortError` that names the termination signal, or the error of the crash.
_Avoid_: Reason alone (a reason can also tell that the scope ended)

**Cleanup**:
The work that the program does after the signal aborts and before the process exits: the end of each `using` and `await using` scope, and each client that it closes. The program runs the cleanup, not the package.
_Avoid_: Hook (the package runs no hooks), teardown

**Default action**:
What the kernel does with a termination signal when the process has no listener for it: it ends the process. For a crash, the default of Node.js: it writes the error and ends the process with exit code 1.
_Avoid_: Default handler

**Death by the signal**:
The process ends by a termination signal, not with an exit code. A shell shows 128 + the number of the signal: 130 for SIGINT, 143 for SIGTERM.
_Avoid_: Exit with 130 (an exit code of 130 is a normal exit, and a shell does not stop a script for it)

**Re-raise**:
The package sends the termination signal of the cause to its own process again, after it removes each listener for that signal. Then the default action ends the process.
_Avoid_: Forward (a parent forwards a signal to a child), resend

**Exit status**:
What the parent of the process gets when it waits for the process: the termination signal that ended it, or its exit code.
_Avoid_: Exit code (one kind of exit status)

**Supervisor**:
The program that starts the process and stops it: a shell, Docker, Kubernetes, systemd or Nx. It owns the deadline of a shutdown, and it sends SIGKILL after the deadline.
_Avoid_: Parent alone (a parent can be a script that does not stop the process), orchestrator

**Init process**:
PID 1 of a container. The kernel does not apply the default action of a signal to PID 1. With `init: true`, tini is PID 1, and the program is not.
_Avoid_: Entrypoint (the command that the image starts)

**Scope**:
The life of a `Shutdown`, from `new Shutdown()` to `[Symbol.dispose]()`. At the end of the scope, the package removes its listeners and aborts the signal. A stop request that came before the end of the scope stays.
_Avoid_: Lifetime, session

## Relationships

- A **Shutdown** has one **Signal** and one **Scope**.
- The first **Stop request** in the **Scope** is the **Cause**. It aborts the **Signal**.
- After the **Cleanup**, a **Termination signal** as **Cause** gives a **Death by the signal** through a **Re-raise**. When the process is PID 1, it gives exit code 128 + n.
- A **Crash** as **Cause** gives exit code 1.
- The **Supervisor** ends a **Shutdown** that does not end, with SIGKILL after its deadline.
