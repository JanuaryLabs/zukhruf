# The client speaks the Engine API, not the Docker CLI

On 2026-10-20, a search of 13 repositories found about 90 files that talk to Docker. They reach the engine in three ways:

- **The Docker CLI**, through `nano-spawn`, `execa` or `execFile`. `@zukhruf/testing/docker`, the sandbox of `@deepagents/context`, the volume adapter of text2sql, finetuning and april do this. Each one turns the text on standard error into errors with regular expressions: `docker.ts` and `container.ts` of `@zukhruf/testing` and its global setup, `docker-sandbox.ts:311`, `:533-549` and `:917` of `@deepagents/context`, and `volume-adapter.ts:57-69` of text2sql. That makes more than 11 expressions in three homes.
- **The Engine API, written by hand.** The finders of text2sql (`packages/finders/discovery/src/docker-engine.ts`) send `GET /containers/json` through `node:http`. The packaged desktop app of text2sql started the CLI first. An app that starts from the macOS Dock gets the `PATH` of launchd, which has no `docker`, so discovery found nothing for 13 days (text2sql `304c5c51`). A lint rule of text2sql now refuses the CLI in that code (`eslint.config.mjs:519-536`).
- **dockerode**, in serverize and in one script of sdk-it. deepagents lists dockerode as a dependency but does not import it.

The places that do the same work are more than three for each operation. Examples: the life of a container (7 or more places), an exec that gives back an exit code and its output (8 or more), and the question "Is Docker available?" (5). This project follows the Rule of Three, so this work has one home now: this package.

The Docker CLI is itself a client of the Engine API. Each program that uses Docker as a library also speaks the Engine API:

- the Go client of Moby, [`moby/moby/client`](https://github.com/moby/moby/tree/master/client), which the CLI is built on;
- [bollard](https://github.com/fussybeaver/bollard) for Rust;
- [docker-modem](https://github.com/apocas/docker-modem), the transport of dockerode;
- Testcontainers for Node.js (through dockerode) and for Java (through docker-java).

The text that the CLI writes on standard error is for a person to read, and it can change in any release. The status codes of the Engine API are part of its contract: 404 for a missing container, 409 for a conflict, 304 for a container that is already started. A probe on 2026-10-20 sent `GET /v1.51/containers/<missing name>/json` to an engine on another machine (Docker 28.5.0) through `ssh … docker system dial-stdio`, with `node:http` only. The engine answered `404 {"message":"No such container: …"}`.

The CLI also adds work that a request does not need:

- The CLI catches SIGTERM and exits with 0 (`cli-process.ts:32-35` of `@deepagents/context`), so each caller sends SIGKILL instead.
- A CLI command can live on after the test process that started it is killed. Thus `@zukhruf/testing` writes a process record for each Docker command (`#recorded` in `host.ts`).
- `nano-spawn` removes the last newline of the output. Thus the copies send file content as base64 (`directory.ts` of `@zukhruf/testing`, `volume-adapter.ts` of text2sql).

## Considered Options

- **Keep the Docker CLI.** Move the CLI code of `@zukhruf/testing/docker` into a base package. The text2sql desktop app still cannot use it, so the Engine API client of text2sql stays a second copy. The regular expressions stay.
- **dockerode.** A base package of zukhruf imports only Node.js and other base packages ([ADR 0001 of zukhruf](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md)). dockerode 5.0.1 brings `@grpc/grpc-js`, `protobufjs`, `tar-fs` and docker-modem. docker-modem brings `ssh2`, and `ssh2` has the native optional dependencies `cpu-features` and `nan`, which an Electron app must package. docker-modem reads `DOCKER_HOST` but not Docker contexts. Its types come from DefinitelyTyped, not from the package.
- **A client generated from the Engine API specification** ([`api/swagger.yaml`](https://github.com/moby/moby/blob/master/api/swagger.yaml), Swagger 2.0). It gives each of the 108 operations of the API (version 1.57), but the package uses 40. A generator does not know the multiplexed stream or the hijacked connection, so attach, exec and logs need code by hand all the same.
- **The Engine API through `node:http`.** This option was selected.

## Consequences

- The package is in the base layer and has no dependencies. `node:http` reaches a Unix socket and a Windows named pipe through `socketPath`. For an SSH engine, a connection helper gives `node:http` a stream through `createConnection` (see [ADR 0002](./0002-the-engine-is-the-one-that-the-docker-cli-selects.md)).
- The options of each request are the fields of the Engine API, with the names that the Engine API reference gives them: `Image`, `Env`, `HostConfig.PortBindings`. The Go client of Moby uses the same names, and so does dockerode. The package adds no second name for a field. A consumer with its own options, such as the sandbox of `@deepagents/context`, maps them to these fields one time.
- An error carries the HTTP status. A lookup of a missing container, volume or image gives `undefined`. A start of a running container, a stop of a stopped container, and a removal of a missing container do nothing. Each error that a caller handles differently has its own class, chosen by the request and its status ([ADR 0007](./0007-an-error-has-its-own-class-when-the-caller-handles-it-differently.md)).
- An exec gives back its exit code. A non-zero exit code is data, not an error: three copies in `@deepagents/context` and one in text2sql turn the error of the CLI back into an exit code.
- A signal cancels a wait for the engine. A cancel does not stop an exec, because the Engine API has no request that stops one. The CLI has the same limit: a killed `docker exec` leaves its command running. Thus the sandbox of `@deepagents/context` records the process id of each command and kills the command itself (`docker-sandbox.ts:625-658`).
- The package has no timeout of its own. Each call takes a signal, so the caller sets the time limit with `AbortSignal.timeout()`. A probe of an engine that does not answer then stops at the caller's limit (zukhruf backlog #2175).
- Image builds and Compose stay with the CLI. A build with BuildKit needs its session protocol, and Compose is a plugin of the CLI. The package gives the environment that sends the CLI to the same engine.
- Exec with standard input closes the write side of the hijacked connection, so the command reads the end of its input. A Windows named pipe has no shutdown of one side: `socket.end()` of Node.js only flushes the pipe (`uv__pipe_shutdown` of libuv calls `FlushFileBuffers` and sends nothing). The engine listens on its pipe in message mode "so that CloseWrite() is supported" (`daemon/listeners/listeners_windows.go` of Moby), and `CloseWrite` of go-winio writes a message of zero bytes, which the reader takes as the end. Node.js passes a write of zero bytes to libuv (a probe on 2026-10-20 saw `writeBuffer` with length 0), and libuv passes it to `WriteFile`. Thus on a Windows named pipe the client writes a message of zero bytes as its close. No run on Windows proves this yet (zukhruf backlog #2753).
- `@zukhruf/testing/docker` builds on this package (zukhruf backlog #2752). Thus the layer table of zukhruf changes: the shipped code of the tool layer may import the base layer. The tests of this package cannot import `@zukhruf/testing`, because that import makes a cycle. They use `node:test` and remove what they create in `try`/`finally`.
- The global teardown of `@zukhruf/testing` must be synchronous, because Node.js does not wait for it under `--test-force-exit`. A probe on 2026-10-20 with Node.js 26.10.0 confirmed this: an asynchronous teardown under `--test-force-exit` did not finish. A teardown that started a worker and waited for it with `Atomics.wait` finished. Thus the teardown can run this asynchronous client in a worker, with no CLI.
