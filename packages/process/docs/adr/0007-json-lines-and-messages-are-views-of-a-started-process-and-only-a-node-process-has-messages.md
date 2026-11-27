# JSON lines and messages are views of a started process, and only a Node process has messages

Status: Accepted 2026-11-27 (backlog #6077).

Decision-makers: the zukhruf session of backlog #6077 proposes this from the leaders and ADR 0001. Ezz rules on it in the review of the paper.

Two ways to talk to a started process exist in zukhruf. `Coprocess` sends one JSON value on each line of stdin and reads one from each line of stdout. `startWorker` sends and receives messages over the IPC channel of Node.js. An IPC channel exists only when the parent opens it at the start, and only a Node.js child can use it: a test of the probes of 2026-11-27 showed that a child started through a shell has no `process.send`.

No leader has a separate type for a process that the parent talks to: it is the process type with piped stdio (ADR 0001). The framing is the caller's, or a small type over the pipes.

## Decision

- `Coprocess` is the JSON-lines view of a started process. `new Coprocess(process)` takes a started process whose stdin and stdout are piped (a `PipedProcess`, which `start()` of a command gives by default) and keeps it as `coprocess.process`. `send`, `receive` and `request` keep the behavior of `@zukhruf/coprocess` today, with its errors.
- `NodeProcess` is a started process that runs JavaScript source as a module in its own Node.js, with an IPC channel. `start()` of a `NodeCommand` gives it ([ADR 0010](./0010-a-command-says-what-to-run-and-run-and-start-are-its-methods.md)). It has `send(message)`, the `messages` so far, and `next(match, { signal })`, which resolves with the first selected message, sent before or after the call. `run()` of a `NodeCommand` runs the source to its end, as `run()` of a `Command` does.
- Only `NodeProcess` has messages, and only its `ready` takes `{ message }`. A started process of another command has no such member, so a caller cannot wait for a message that can never come.

## Considered Options

- **Messages on each started process, as an option `ipc: true`.** A started process with `ipc: false` would have a `next` that never resolves. The type would allow it.
- **One class with a mode for JSON lines, IPC or raw streams.** The members of each mode would be on each instance.
- **Views that take a started process.** This option was selected.

## Consequences

- The `admit` option of `startWorker` (a function that gets the child before it can send) stays as an option of `NodeProcess.start`, for the mutex tests that join a child to a coordinator.
- The name of a `NodeProcess` is its `name` option, as for each started process, and it is `argv[1]` of the source, as in `startWorker` today.
