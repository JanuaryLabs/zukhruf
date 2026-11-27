# JSON lines and messages are views of a started process, and only a Node process has messages

Status: Accepted 2026-11-27 (backlog #6077).

Changed in part on 2026-11-27 (backlog #6077, unit 3, built): `next()` rejects with `ProcessEndedError` when the process ends before a selected message, `<name> ended (<end>) before it sent '<type>'` for a type and `... before it sent a selected message` for a function (ADR 0006). A message that came before the end still resolves a `next()` called after it, because execa settles the end only after the channel closed, and every message is in `messages` by then. The IPC channel is fd 4 of a run and of a start (since the keeper B'' of ADR 0004, 2026-11-27; before it, fd 4 of a start carried the pid report and the channel was fd 5). `send(message)` throws `ERR_IPC_CHANNEL_CLOSED` at the call once the channel has closed: Node.js reports a closed channel only later, as an `'error'` event of the child that would crash a parent that does not listen to it.

Changed in part on 2026-11-27 (backlog #6077, unit 4, built): the errors of `Coprocess` are not those of `@zukhruf/coprocess`. When the process ends, `exited()` resolves with a `ProcessEndedError`, `<name> ended (<end>) before it sent a line: <stderr tail>`, with `end` and `stderr`, and each later `receive()` rejects with that same error value; a line that is not JSON still fails only its own `receive()`. `Coprocess` reads stdout through `process.lines()`, so another reader of the lines gets every line too, and each line comes before the end: a value written just before the end still reaches `receive()`. `close()` resolves with the end. There is no `kill()`: a caller stops the process with `process.stop()` or the disposal, and a `receive()` that waits then rejects with the end of the stop. A send after the end does not crash the parent: execa listens to the errors of stdin, such as `EPIPE`, and the end reports what happened.

Decision-makers: the zukhruf session of backlog #6077 proposes this from the leaders and ADR 0001. Ezz rules on it in the review of the paper.

Two ways to talk to a started process exist in zukhruf. `Coprocess` sends one JSON value on each line of stdin and reads one from each line of stdout. `startWorker` sends and receives messages over the IPC channel of Node.js. An IPC channel exists only when the parent opens it at the start, and only a Node.js child can use it: a test of the probes of 2026-11-27 showed that a child started through a shell has no `process.send`.

No leader has a separate type for a process that the parent talks to: it is the process type with piped stdio (ADR 0001). The framing is the caller's, or a small type over the pipes.

## Decision

- `Coprocess` is the JSON-lines view of a started process. `new Coprocess(process)` takes a started process whose stdin and stdout are piped (a `PipedProcess`, which `start()` of a command gives by default) and keeps it as `coprocess.process`. `send`, `receive` and `request` keep the behavior of `@zukhruf/coprocess` today, with its errors (changed in part by unit 4, above).
- `NodeProcess` is a started process that runs JavaScript source as a module in its own Node.js, with an IPC channel. `start()` of a `NodeCommand` gives it ([ADR 0010](./0010-a-command-says-what-to-run-and-run-and-start-are-its-methods.md)). It has `send(message)`, the `messages` so far, and `next(match, { signal })`, which resolves with the first selected message, sent before or after the call. `run()` of a `NodeCommand` runs the source to its end, as `run()` of a `Command` does.
- Only `NodeProcess` has messages, and only its `ready` takes `{ message }`. A started process of another command has no such member, so a caller cannot wait for a message that can never come.

## Considered Options

- **Messages on each started process, as an option `ipc: true`.** A started process with `ipc: false` would have a `next` that never resolves. The type would allow it.
- **One class with a mode for JSON lines, IPC or raw streams.** The members of each mode would be on each instance.
- **Views that take a started process.** This option was selected.

## Consequences

- The `admit` option of `startWorker` (a function that gets the child before it can send) stays as an option of `NodeProcess.start`, for the mutex tests that join a child to a coordinator.
- The name of a `NodeProcess` is its `name` option, as for each started process, and it is `argv[1]` of the source, as in `startWorker` today.
