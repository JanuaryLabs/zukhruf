# The exit is an event, and the package uses execa

Three classes kept a long-lived process that takes and gives JSON values on lines: `VisionWorker` and `TranscriptionWorker` in elt, and `ClaudeSupervisor` in trashbot. Each started the process, kept stderr for its error, failed the waiting answer on an exit or on a line that is not JSON, and stopped the process with a signal. A fix had to go into each copy. Thus the class is in this package, and the three classes use it.

A pool must know when a worker can no longer work. The first design gave the worker a `dead` property that the pool read before it lent the worker. A property can say `false`, and the process can exit a moment later; the pool then lent a worker that failed its job. execa gives no such property: a subprocess is a promise that settles at its exit. nano-spawn gives the Node.js `ChildProcess` only through a promise. Thus the exit is an event: `exited()` settles once, from a latch of `@zukhruf/async`, and a pool listens to it. Piscina, a pool of Node.js worker threads, replaces a worker on its `exit` event in the same way.

A process can need time to stop. On 2026-10-26 a probe sent SIGTERM to each process, idle and while it worked. The Vision helper (Swift) and the transcription helper (Rust) have no signal handler, and stopped in 4 to 7 ms. The Claude command-line program saves its state on SIGTERM, and stopped in about 900 ms with exit code 143. Thus `kill` sends SIGTERM, and SIGKILL after a grace period, as Kubernetes and systemd do. execa does this with its `forceKillAfterDelay` option, whose default is 5000 ms.

## Considered Options

- **A `dead` property that reads the state of the `ChildProcess`.** The read and the exit race. With execa it also needs a type assertion, because the type of the execa subprocess does not show `killed`, `exitCode` or `signalCode`.
- **nano-spawn 2.1.0.** It keeps all of stderr while nobody iterates it, it has no step from SIGTERM to SIGKILL, and its error message contains the command line.
- **`node:child_process` only.** It works: the package had this form first, and its tests passed. It needs its own timer for SIGKILL. execa gives the same step, and the package already reads the exit from its promise.
- **execa's `maxBuffer` for stderr.** When stderr is larger than `maxBuffer`, execa stops the process. A process that writes to stderr for hours would stop. Thus the package keeps the last 16 KiB of stderr itself.
- **execa's error message.** It contains the command line. The arguments of the Claude program contain its prompt and its MCP configuration. Thus the package writes its own message: the name, the exit code or signal, and the end of stderr.
