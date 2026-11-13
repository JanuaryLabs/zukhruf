# Only a failure before the answer is a connection failure

A connection to the engine can fail at four moments:

- (a) The connection does not open: the socket does not exist, or the engine refuses the connection.
- (b) The connection opens, and it dies before the answer.
- (c) The connection dies inside a JSON answer.
- (d) The connection dies inside a stream: events, followed logs, the progress of a pull, an attach, the output of an exec.

Backlog #4315 asked what a caller gets in each case. Before this decision, the package gave this:

- (a) and (b) were a `ConnectionFailedError` with one message, "Cannot connect to the engine at …". In case (b) the message was wrong, because the connection did open.
- A socket that exists and that the system denies (`EACCES`) gave the `connect EACCES` error of Node, not an error of the package.
- (c) and (d) gave the error of Node: the message `aborted` and the code `ECONNRESET`. No document said so, and the documentation of `events()` said that the iteration "ends only when the signal aborts".

The maintainer gave the rule on 2026-11-13: follow what the leading tools do, and do not add an opinion of our own.

This is what the leading tools do. Their source was read on 2026-11-13 at the commits of the links. Each client library was also run against a fake engine on a Unix socket that closes the connection at each of the four moments (Node 26.13.0, `moby/moby/client` v0.6.2, dockerode 5.0.1 with docker-modem 5.0.7, docker-py 7.2.0, bollard 0.21.1). "Own" means an error type of the tool, not the error of its runtime or of its HTTP library.

| Tool                                                                                                                                                                                                                                                                                                                                                                                       | (a) refused, or no socket                                              | (b) dies before the answer                                           | (c) dies inside a JSON answer                                   | (d) dies inside a stream                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Go client of Moby ([errors.go](https://github.com/moby/moby/blob/28396bf4817db0f6619d6656cded0877aae11293/client/errors.go#L11-L40), [request.go](https://github.com/moby/moby/blob/28396bf4817db0f6619d6656cded0877aae11293/client/request.go#L131-L220), [system_events.go](https://github.com/moby/moby/blob/28396bf4817db0f6619d6656cded0877aae11293/client/system_events.go#L28-L90)) | Own: `errConnectionFailed`, "Cannot connect to the Docker daemon at …" | Own, the same type: `errConnectionFailed`, "error during connect: …" | Not own: the read error of Go, `unexpected EOF`                 | Not own: the read error of Go                                                                               |
| Docker CLI ([events.go](https://github.com/docker/cli/blob/eaae503a22566c7760c0b28df92cfdef36428379/cli/command/system/events.go#L81-L93), [docker.go](https://github.com/docker/cli/blob/eaae503a22566c7760c0b28df92cfdef36428379/cmd/docker/docker.go#L43-L55))                                                                                                                          | Prints the text of the Go client                                       | Prints the text of the Go client                                     | Prints the text of the Go client                                | Prints the text of the Go client. A clean end of the stream prints nothing, and the exit code is 0          |
| docker-modem, used by dockerode ([modem.js](https://github.com/apocas/docker-modem/blob/5dc56742059c7f9d73691d3aeb9f012f8f01b156/lib/modem.js#L339-L407))                                                                                                                                                                                                                                  | Not own: the error of Node (`ENOENT`, `ECONNREFUSED`)                  | Not own: `socket hang up` of Node                                    | The promise never settles                                       | Not own: `aborted` of Node, on the stream that the caller holds                                             |
| docker-py ([errors.py](https://github.com/docker/docker-py/blob/e734fd5a5508bc1062a28a51dc2f31ae47af7a2f/docker/errors.py#L23-L40), [daemon.py](https://github.com/docker/docker-py/blob/e734fd5a5508bc1062a28a51dc2f31ae47af7a2f/docker/types/daemon.py#L27-L33))                                                                                                                         | Not own: `requests.exceptions.ConnectionError`                         | Not own: `requests.exceptions.ConnectionError`                       | Not own: `requests.exceptions.ChunkedEncodingError`             | Events and followed logs end with no error. The progress of a pull gives `urllib3.exceptions.ProtocolError` |
| bollard ([errors.rs](https://github.com/fussybeaver/bollard/blob/46df0d3139cbe2791036150ef7111e6d511392dc/src/errors.rs#L6-L247))                                                                                                                                                                                                                                                          | A variant that carries the error of hyper: `HyperLegacyError`          | The same variant: `HyperLegacyError`                                 | A variant that carries the error of hyper: `HyperResponseError` | A variant that carries an I/O error: `IOError`                                                              |

Only the Go client of Moby has an error of its own for a connection, and that error ends at the start of the answer. `doRequest` in `request.go` wraps the error of `http.Client.Do`, and nothing later:

- A dial error says "Cannot connect to the Docker daemon at …". A denied socket (`os.ErrPermission`) is in the same type, with the text "permission denied while trying to connect to the docker API at …".
- Each other failure before the answer says "error during connect: …", and it keeps the first error inside.
- A failure after the answer started is not wrapped. The documentation of `Events` in `system_events.go` says: "It's up to the caller to reopen the stream in the event of an error by reinvoking this method."

No surveyed tool has an error of its own for a connection that is lost after the answer started.

Node gives the code `ECONNRESET` to its own two errors. Before the answer, a socket that closed gives `socket hang up` on the request. After the answer started, Node destroys the body with `aborted` ([`socketCloseListener`](https://github.com/nodejs/node/blob/925faf48f950d9d2209b544194568cbea3d6d7fd/lib/internal/http/client.js#L745-L778)).

## Considered Options

- **A package error for a lost stream**, for example a `ConnectionLostError` for cases (c) and (d). No surveyed tool has one. The next step of the caller is the same with the error of Node: start the stream again.
- **Leave `EACCES` as the error of Node.** The Go client of Moby puts a denied socket in its connection error. A caller that catches `ConnectionFailedError` to treat the engine as absent then misses an engine whose socket it cannot open.
- **One message for cases (a) and (b).** "Cannot connect" is false for a connection that opened and then died. The Go client has one type and two texts.
- **A second class for case (b).** The Go client has one type, and `IsErrConnectionFailed` is true for both cases. The next step of the caller is the same.
- **The rule of the Go client of Moby: one class with two messages before the answer, and the error of Node after it.** This option was selected.

## Consequences

- `ConnectionFailedError` stays one class with `host` and `cause`. It covers each failure before the answer starts. Its message is one of two:
  - `Cannot connect to the engine at <host>.` for a connection that did not open. The code of the `cause` is `ENOENT` (no socket, or no `ssh` on the `PATH`), `ECONNREFUSED` or `EACCES`.
  - `Error during the connection to the engine at <host>.` for each other failure before the answer. The `cause` has the code `ECONNRESET` (also the `socket hang up` of Node) or `EPIPE`, or it is the exit error of `ssh`. An `ssh` that cannot log in, for example "Permission denied (publickey)", is in this case: the `ssh` process started, and then it exited.
- The class makes its message from the code of its `cause`. Thus no line of the package can give a cause the message of the other case.
- `EACCES` on the socket is now a `ConnectionFailedError`. Before, it was the error of Node.
- A connection that is lost after the answer started gives the error of Node, as before: the message `aborted` and the code `ECONNRESET` for a JSON answer and for a stream, and the error of the socket for a hijacked connection. It is not a `DockerError`. For an SSH engine, Node sets its `cause` to the exit error of `ssh`. The caller starts the stream again.
- The documentation of `events()` no longer says that the iteration ends only when the signal aborts.
- [ADR 0007](./0007-an-error-has-its-own-class-when-the-caller-handles-it-differently.md) still gives the list of the classes. This decision adds no class.
- These parts were not covered:
  - The `docker` binary was not run. What it prints comes from its source and from the measured error of the Go client.
  - No real engine was restarted, so it is not known whether a restart ends a stream cleanly or cuts it.
  - A Windows named pipe was not run (backlog #2753).
  - The fake engine closes the connection with a clean end. A reset (RST) was not run for any tool. For a hijacked connection, a clean end inside a frame ends the iteration with no error, in this package and in the Go client; a reset can give an error.
