# Output is one stream of chunks, and only a close ends the input

An attach, an exec and the logs of a container without a TTY give a multiplexed stream: frames on one connection, each frame marked as standard output or standard error. The first design split it into two `ReadableStream`s, `stdout` and `stderr`.

Two streams on one connection make the caller choose between two failures. When the caller reads only `stdout`, the frames of standard error stay unread. The package can then stop reading the connection until the caller reads `stderr`, and standard output stops too. Or it can keep the frames of standard error in memory with no limit. The two streams also lose the order between standard output and standard error.

microsandbox gives one `AsyncIterable<ExecEvent>` for each exec: `started`, `stdout`, `stderr` and `exited` (`dist/exec-event.d.ts`, 0.7.8). The frames of the Engine API already carry the same mark.

The end of the input has a trap. On a Unix socket and over SSH the package ends the input with a shutdown of the write side. On a Windows named pipe it ends the input with a message of zero bytes ([ADR 0001](./0001-the-client-speaks-the-engine-api-not-the-docker-cli.md)). Thus an empty write of the caller on Windows would end the input. microsandbox makes the end its own call: `Job.eof()`, and "An empty buffer never sends EOF" (`dist/jobs.d.ts`).

## Considered Options

- **Two streams, as Node.js gives for a child process.** A child process has two pipes, so it can stop one without the other. A multiplexed stream has one connection.
- **One stream of chunks.** Each chunk names its stream. This option was selected.

## Consequences

- A container process is an `AsyncIterable` of `{ stream: 'stdout' | 'stderr', data: Uint8Array }`, in the order of the engine. A caller that wants only standard output skips the other chunks. The package reads the connection as fast as the caller iterates. It reads ahead at most the default high-water mark of Node ([ADR 0012](./0012-a-reset-ends-the-output-and-a-failed-write-is-an-error-only-when-output-can-be-lost.md)).
- `collect()` reads all chunks and gives `{ exitCode, stdout, stderr, output }`. `exec()` and `containers.run()` give the same result.
- `exitCode` is a promise. For an exec, the package reads it with `GET /exec/{id}/json` after the output ends. For an attach, it reads it with `POST /containers/{id}/wait`.
- The output of a container with a TTY is a raw stream. Each of its chunks is `stdout`. The TTY setting chooses the form, not the Content-Type of the answer ([ADR 0014](./0014-output-framing-follows-the-tty-setting-as-the-docker-cli-chooses-it.md)).
- `followLogs()` gives the same chunks for the logs of a running container, until the container stops or the signal aborts.
- `stdin` is a `WritableStream`. Only its `close()` ends the input. The package drops an empty write, so an empty write never ends the input on any host.
- An attach or an exec without `stdin` ends the input at once, before it reads any output. The Docker CLI does the same: `beginInputStream` of [hijack.go](https://github.com/docker/cli/blob/eaae503a22566c7760c0b28df92cfdef36428379/cli/command/container/hijack.go) copies stdin only when there is one, and then always calls `CloseWrite()`. Moby does not wait for it, but socktainer, an Engine API server on top of Apple's `container` tool, does: it keeps the output of an attach open until the client ends its input. A probe on 2026-11-15 of `sh -c "echo hi"` got its output in 17 ms on Docker Desktop and none in 15,000 ms on socktainer. Added on 2026-11-15.
- For a command that ends before it reads all of its input, see [ADR 0012](./0012-a-reset-ends-the-output-and-a-failed-write-is-an-error-only-when-output-can-be-lost.md).
- The package gives each chunk once. A second iteration of the same container process is an error.
- The input also ends when the process that holds the connection exits. `attach()` and `spawn()` take `ref: false`, so a held connection does not keep its process running. Then a `cat` on that input is a holder: it ends with its holder process, for any reason, also `SIGKILL`. Added on 2026-11-14 for one reaper of a run with one `cat` exec for each holder process (`@zukhruf/testing` ADR 0020, after Ryuk of Testcontainers, which counts its connections).
