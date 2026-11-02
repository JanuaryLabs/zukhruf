# A crash starts a shutdown

A crash is an exception that no code catches, or a rejection that no code handles. Node.js writes the error and ends the process with exit code 1. No cleanup runs: a SQLite file is left in the middle of a write, and a Postgres client does not close its connection.

The Node.js documentation of `'uncaughtException'` says: "It is not safe to resume normal operation after 'uncaughtException'." A shutdown does not resume the work. It stops the work and runs the cleanup.

`close-with-grace` turns a crash into the same graceful close as a termination signal, and the `eject` server templates of fastify-cli use it. Three servers of text2sql do the same with terminus: a crash sends SIGTERM to its own process, so one cleanup handles each fatal error.

## Considered Options

- **Leave a crash to Node.js.** The process ends at once, with no cleanup.
- **A crash is a stop request.** This option was selected.

## Consequences

- The package listens for `'uncaughtException'` and `'unhandledRejection'`. With a listener, Node.js does not write the error, so the package writes it to standard error with `console.error()`.
- The signal aborts with the error of the crash as its reason. Code that reads `signal.reason` gets the error.
- At `'exit'`, the package sets `process.exitCode` to 1 when it is 0. An exit code that the program set stays. A supervisor restarts a failed process only after a non-zero exit, so a crash must not exit with 0. With `useExit0: true`, terminus exits with 0 after a crash.
- A second crash gets the default of Node.js ([ADR 0002](./0002-only-the-first-stop-request-starts-a-shutdown.md)). Thus a cleanup that crashes ends the process at once, with exit code 1. After a termination signal, the package writes the error of the crash, and the process dies by that signal, because the exit status follows the cause.
- A cleanup that does not end after a crash is ended by a termination signal, or by the deadline of the supervisor.
