# Docker

A client for the Docker Engine API. It selects an engine the way the Docker CLI does, and it sends HTTP requests to that engine. It owns no policy: which engine a product uses, and what its containers do, stay in the product. Cancel and signal have the meanings that [the async glossary](../async/CONTEXT.md) gives them.

## Language

**Engine**:
The Docker daemon that a client sends its requests to. A `Docker` client keeps the engine it connected to.
_Avoid_: Daemon, server, host (for the engine itself)

**Engine API**:
The HTTP API of the engine, as the [Engine API reference](https://docs.docker.com/reference/api/engine/) documents it. The Docker CLI is a client of this API too.
_Avoid_: Docker API, REST API

**Host**:
The address of an engine, as a URL: `unix:///var/run/docker.sock`, `npipe:////./pipe/docker_engine`, or `ssh://user@machine`. Docker uses the same word in `DOCKER_HOST` and in the `Host` field of a context.
_Avoid_: Endpoint (a context groups a host with its TLS settings into an endpoint), socket (one kind of host)

**Context**:
A name for a host, as `docker context` keeps it. The `default` context is not in the context store: its host is `DOCKER_HOST`, or the default host of the platform.

**Context store**:
The directory where the Docker CLI keeps its contexts: `contexts/meta/<sha256 of the name>/meta.json` in the Docker configuration directory (`DOCKER_CONFIG`, or `~/.docker`).

**Current context**:
The context that the Docker CLI selects when a command names none: `DOCKER_CONTEXT`, else `currentContext` in `config.json`, else `default`. When `DOCKER_HOST` is set, the CLI uses the `default` context with that host, whatever the current context is.

**Connection helper**:
The program that carries an HTTP connection to an SSH engine. `ssh` starts `docker system dial-stdio` on the remote machine, and the client sends HTTP through the standard input and output of `ssh`. Docker calls it a connhelper.
_Avoid_: Tunnel, port forward (`@zukhruf/testing` forwards a container's port, which is another thing)

**API version**:
The version of the Engine API in the path of each request, as in `/v1.51/containers/json`. The client negotiates it once, when it connects: it uses the lower of its own highest version and the engine's `ApiVersion`.

**Connection failure**:
The engine did not accept the connection: its socket does not exist, it refuses the connection, or `ssh` cannot log in. A stopped Docker Desktop leaves its socket file behind and refuses each connection. Docker's Go client uses the same term (`IsErrConnectionFailed`).
_Avoid_: Engine down, offline, unavailable

**Handle**:
An object that names one container or one volume on one engine. Disposal of a handle removes the container or the volume.
_Avoid_: Instance, reference, wrapper

**Hijacked connection**:
An HTTP connection that the engine upgrades to a two-way stream of bytes, for attach and for the start of an exec.

**Multiplexed stream**:
The format of the output of a container that has no TTY: frames, each with an 8-byte header. The first byte of the header is the stream (0 stdin, 1 stdout, 2 stderr), the next three bytes are zero, and the last four bytes are the length of the frame, big-endian. The media type is `application/vnd.docker.multiplexed-stream`.
_Avoid_: Docker stream, framed output

**Raw stream**:
The output of a container that has a TTY. It has no frames, and standard output and standard error are one stream.

**Exec**:
A command that the engine runs in a running container, next to its main process. The Engine API has no request that stops an exec.
_Avoid_: Docker exec (the CLI command), job

**Container process**:
The streams of an exec or of an attached container: standard input, standard output, standard error, and the exit code when it ends.
_Avoid_: Subprocess, child process (both run on this machine)
