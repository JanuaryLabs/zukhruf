# @zukhruf/shutdown

> **Status: design for review.** This README is the API on paper. No code exists yet. The decisions are in [ADR 0001](./docs/adr/0001-the-process-dies-by-its-termination-signal-after-the-cleanup.md), [ADR 0002](./docs/adr/0002-only-the-first-stop-request-starts-a-shutdown.md) and [ADR 0003](./docs/adr/0003-a-crash-starts-a-shutdown.md).

A graceful shutdown for a Node.js program. When the user presses Ctrl-C, or Docker stops the container, the program does not end at once. Its work stops when the signal aborts, its cleanup runs, and then the process ends by the same termination signal. Thus the shell, Docker or Kubernetes sees an interrupted process, not a process that completed its work. The package has no dependencies.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Stop the work at a termination signal

Make one `Shutdown` at the start of the entry point, before the first `await`. Then a termination signal during the start also stops the work. Give the signal to the work:

```ts
import { Shutdown } from '@zukhruf/shutdown';

using shutdown = new Shutdown();
using warehouse = new Warehouse('credits.sqlite');
await pipeline.run({ signal: shutdown.signal });
```

The user presses Ctrl-C while the pipeline runs. Then:

1. The signal aborts. Its reason is a `DOMException` with the name `AbortError` and the message `The process received SIGINT`.
2. The pipeline stops at its next check of the signal, and `run()` returns.
3. The `using` scopes end in reverse order: `warehouse` closes, then `shutdown`.
4. The event loop has no more work. Node.js emits `'exit'`.
5. The package removes each listener for SIGINT and sends SIGINT to its own process. The process dies by SIGINT.

SIGINT, SIGTERM and SIGHUP start a shutdown. SIGQUIT does not: Ctrl-\ keeps its default action, which ends the process and writes a core dump.

## What the parent sees

| Cause of the shutdown                          | Exit status                                          |
| ---------------------------------------------- | ---------------------------------------------------- |
| A termination signal                           | The process dies by that signal                      |
| A termination signal, and the process is PID 1 | Exit code 128 + the number of the signal (143)       |
| A crash                                        | Exit code 1, or the exit code the program set        |
| No stop request                                | The exit code of the program, as without the package |

An exit code of 130 is not the same as a death by SIGINT. A Bash script stops its loop only when the child died by SIGINT. In a terminal, `node app.js && next` runs `next` after Ctrl-C when `app.js` exits with 0. When `app.js` dies by SIGINT, zsh stops the whole line. A parent that calls `waitpid()` sees the difference too: Node.js gives `signal: 'SIGINT'`, not `code: 130`.

## A second stop request

The first stop request removes every signal and crash listener of the package. Thus a second termination signal gets the default action, and the process ends at once. Use this when the cleanup does not end. For example, a read from a pipe that no program writes waits in the thread pool of Node.js, and no signal can stop it. The second Ctrl-C ends the process.

The package has no timer. The supervisor owns the deadline of a shutdown:

| Supervisor | Deadline                                             |
| ---------- | ---------------------------------------------------- |
| A terminal | The user presses Ctrl-C again                        |
| Docker     | 10 s, then SIGKILL (`stop_grace_period` in Compose)  |
| Kubernetes | 30 s, then SIGKILL (`terminationGracePeriodSeconds`) |
| systemd    | 90 s, then SIGKILL (`TimeoutStopSec`)                |
| Nx         | 5 s, then SIGKILL (`NX_PROCESS_KILL_GRACE_PERIOD`)   |

## A crash

A crash is an exception that no code catches, or a rejection that no code handles. Without the package, Node.js writes the error and ends the process at once. With the package, a crash is a stop request:

1. The package writes the error to standard error.
2. The signal aborts. Its reason is the error of the crash.
3. The work stops, and the cleanup runs, as for a termination signal.
4. The process exits with code 1.

A second crash gets the default of Node.js: it writes the error and ends the process at once. A termination signal after the crash also ends the process at once.

## Stop at the end of a scope

When the `using` scope of a `Shutdown` ends, the package removes its listeners and aborts the signal. Its reason is a `DOMException` with the name `AbortError` and the message `The shutdown scope ended`. This is not a stop request: the process does not die by a termination signal. A termination signal after this gets the default action.

A stop request that came before the end of the scope stays. The process still ends by its cause at `'exit'`.

## Run in a container

When the image starts the program with `CMD ["node", "main.js"]`, Node.js is PID 1. The kernel does not apply the default action of a signal to PID 1, so the process cannot die by the termination signal. Then the package sets the exit code to 128 + the number of the signal. Docker reports `Exited (143)` for SIGTERM.

Give the container an init process to make the process die by the signal:

```yaml
services:
  app:
    image: app
    init: true
    stop_grace_period: 10s
```

With `init: true`, tini is PID 1. The program dies by the signal, and tini gives that exit status to Docker.

## Stop an HTTP server

The package does not stop a server. Node.js does most of it. An `http.Server` is `AsyncDisposable`, and `server.close()` stops new connections and closes the idle ones:

```ts
import { aborted } from 'node:util';

import { Shutdown } from '@zukhruf/shutdown';

using shutdown = new Shutdown();
await using server = serve({ fetch: app.fetch, port });
await aborted(shutdown.signal, server);
setTimeout(() => server.closeAllConnections(), 1_000).unref();
```

`util.aborted()` also settles when the signal aborted before the call. `events.once(signal, 'abort')` does not.

A probe on Node.js 26.10.0 compared this with `stoppable`, which `@godaddy/terminus` uses:

| Case                             | `stoppable` (grace 1000 ms) | `await using server` | With `closeAllConnections()` after 1 s |
| -------------------------------- | --------------------------- | -------------------- | -------------------------------------- |
| An idle keep-alive connection    | 0 ms                        | 0 ms                 | 0 ms                                   |
| A request that answers in 300 ms | 251 ms                      | 6254 ms              | 1001 ms                                |
| A request that does not answer   | 1001 ms                     | open after 3000 ms   | 1001 ms                                |
| A new client after the stop      | refused                     | refused              | refused                                |

Node.js keeps a connection that becomes idle after the call to `close()` until `keepAliveTimeout` (5000 ms). It keeps a request that does not answer until `requestTimeout` (300 s). A server that must close faster needs a drainer that ends each connection after its last response, as `stoppable` does.

## What the package does not do

- Stop an HTTP server, or make a health check answer 503 during a shutdown. Node.js and the HTTP framework do these. See [Stop an HTTP server](#stop-an-http-server).
- Run cleanup hooks. `using`, `await using` and `AsyncDisposableStack` run the cleanup, in reverse order.
- Stop the work for other causes. `AbortSignal.any([shutdown.signal, failed.signal])` gives a signal that also aborts when the program stops itself.
- Set a deadline. The supervisor sets it.
- Stop child processes. `@zukhruf/coprocess` stops them.
- A choice of termination signals. A program that must live on after its terminal closes runs under a supervisor or in tmux, not under `nohup`: a listener for SIGHUP replaces the ignore of `nohup`.
- Windows. Windows has no POSIX signals.

## The same concepts in other systems

| Concept                                  | Other systems                                                                                                                                                                                                                                                          |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Termination signals that cancel the work | `signal.NotifyContext` of [Go](https://pkg.go.dev/os/signal#NotifyContext); `CancellationToken` and `ctrl_c` of [tokio](https://tokio.rs/tokio/topics/shutdown); `ApplicationStopping` of the .NET Generic Host                                                        |
| Death by the signal after the cleanup    | [Proper handling of SIGINT/SIGQUIT](https://www.cons.org/cracauer/sigint.html) (Cracauer); [Termination in Handler](https://sourceware.org/glibc/manual/latest/html_node/Termination-in-Handler.html) of the GNU C Library; `signal-exit`; `exitAsInterrupted()` of Nx |
| The default action for a second signal   | `stop()` of Go's `NotifyContext`; the SIGINT watcher of Playwright                                                                                                                                                                                                     |
| A crash that starts a graceful shutdown  | `close-with-grace`, which the `eject` server templates of fastify-cli use                                                                                                                                                                                              |
| An init process in a container           | `docker run --init` and tini                                                                                                                                                                                                                                           |

## API

```ts
export class Shutdown implements Disposable {
  /** Listens for SIGINT, SIGTERM, SIGHUP, uncaught exceptions and unhandled rejections. */
  constructor();

  /** Aborts at the first stop request. Its reason is the cause. */
  readonly signal: AbortSignal;

  /** Removes the listeners and aborts the signal. A stop request that came before stays. */
  [Symbol.dispose](): void;
}
```

| Call or event                | What the package does                                                                                                                                                                                     |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `new Shutdown()`             | `process.on()` for SIGINT, SIGTERM, SIGHUP, `'uncaughtException'` and `'unhandledRejection'`                                                                                                              |
| The first termination signal | `process.off()` for each signal and crash listener of the package, then `AbortController.abort()` with the `AbortError`                                                                                   |
| The first crash              | `process.off()` for each signal and crash listener of the package, `console.error()` of the error, then `abort()` with the error                                                                          |
| `'exit'` after a signal      | `process.removeAllListeners()` for that termination signal, then `process.kill(process.pid, signal)`. When the process still runs: `process.exitCode = 128 + n` (`util.convertProcessSignalToExitCode()`) |
| `'exit'` after a crash       | `process.exitCode = 1` when the exit code is 0                                                                                                                                                            |
| `[Symbol.dispose]()`         | `process.off()` for each signal and crash listener of the package, then `abort()`. It keeps the `'exit'` listener only when a stop request came                                                           |

## Who uses each part

The consumers below come from the search of 2026-11-02. None of them dies by the termination signal today. The package itself is backlog mutex #3579.

| Consumer                                                                 | Uses                          | Backlog                |
| ------------------------------------------------------------------------ | ----------------------------- | ---------------------- |
| context-compiler: logful, startup-credits and its eval, what-is-going-on | `signal`, the exit status     | context-compiler #3580 |
| context-compiler: the MCP server of the Codex plugin                     | `signal`, to close the server | context-compiler #3580 |
| elt: the proactive app                                                   | `signal`, the exit status     | elt #3581              |
