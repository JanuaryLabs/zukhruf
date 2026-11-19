# An SSH engine is reached through @zukhruf/ssh in the Node process

For an `ssh://` host, the connection helper of [ADR 0002](./0002-the-engine-is-the-one-that-the-docker-cli-selects.md) and [ADR 0010](./0010-ssh-gets-the-options-of-the-docker-cli-and-the-flags-of-the-caller.md) was one `ssh … docker system dial-stdio` process for each connection. When the process that owned a client died, also by `SIGKILL`, that `ssh` child reached the remote side only as the end of its input. An exec or an attach of a silent command then left the `ssh` child on this machine and `docker system dial-stdio` on the engine host. One laptop held 203 such `ssh` processes, and one engine host held 242 `dial-stdio` processes, the oldest 25 days old (zukhruf backlog #4503).

Ezz decided on 2026-11-17 (#4503): "We need to do the proper one". It is Podman's design: the package speaks SSH in its own process, and each connection to the engine is a channel of that SSH connection, not a remote process. `@zukhruf/ssh` was built for it ([its ADR 0002](../../../ssh/docs/adr/0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md)).

## Decision

`Docker.connect` reaches an `ssh://` host with `@zukhruf/ssh`:

- `OpenSshConfig.resolve(host, { flags: [...sshFlags, '-o', 'ConnectTimeout=30'], environment })`, then `config.dial({ clock, signal })`. `ssh -G` reads `~/.ssh/config` and the caller's flags first, so a flag of the caller wins, and `ConnectTimeout=30` applies only when neither the flags nor the config set one: OpenSSH takes the first value that it gets ([ADR 0010](./0010-ssh-gets-the-options-of-the-docker-cli-and-the-flags-of-the-caller.md) kept the Docker CLI's 30 s).
- The engine socket is the one that the Docker CLI of the engine host selects: a session runs `docker context inspect --format '{{.Endpoints.docker.Host}}'` on the connection, as `docker system dial-stdio` asked that CLI ([ADR 0002](./0002-the-engine-is-the-one-that-the-docker-cli-selects.md)). A `unix://` endpoint gives the path; another endpoint is a `ConnectionFailedError` that names it.
- Each connection of the HTTP client is a `direct-streamlocal@openssh.com` channel to that socket (`client.dial('unix', path)`). The client is one SSH connection; its disposal closes it.
- A server that refuses the channel (Tailscale SSH allows a socket only under the home, `/tmp` and `/run/user/<uid>`, so it refuses a rootful `/run/docker.sock`) gives a `ConnectionFailedError` that names the refusal and the fixes: rootless Docker, whose socket is under `/run/user/<uid>`, or an OpenSSH server. The refusal is an `OpenChannelError` of `@zukhruf/ssh` on the first request. There is no fallback to `docker system dial-stdio`: Ezz, 2026-11-17, "Refuse with a clear error".
- The SSH connection keeps the process alive only while a request is in flight or a stream is held with `ref`: the transport counts its channels in use and calls `client.ref()` and `client.unref()` (Ezz, 2026-11-18, the shape of `RemoteLockClient#updateRef` of `@zukhruf/mutex`); since #4614 the count is a `RefCount` of `@zukhruf/async` (its ADR 0017). No timer.
- An `ssh://` engine needs the `environment` option: `ssh -G` runs with it, and `@zukhruf/ssh` reads `SSH_AUTH_SOCK` and `HOME` from it. The package reads no `process.env`, so `Docker.connect` rejects an `ssh://` engine with no `environment` at once, with a `ConnectionFailedError` that says so (Ezz, 2026-11-18: "Reject clearly"). The `ssh` child of the old helper inherited `process.env`.

## Considered Options

- **The `ssh` child with a watchdog that kills it when its owner dies.** The remote `dial-stdio` still outlives a dead owner for a silent stream, and a second process runs for each connection.
- **`docker system dial-stdio` on a session of `@zukhruf/ssh`, as Podman falls back to it.** The remote process can outlive a dead owner the same way. Ezz ruled out the fallback.
- **`@zukhruf/ssh` with a channel to the engine socket.** This option was selected.

## Consequences

- When the owner dies, the kernel closes its one TCP connection, and the SSH server closes every channel and the engine sockets they opened. No process is left on either machine (`src/ssh-transport.test.ts`, the owner-death test).
- A client pays one SSH handshake when it connects (0.2–0.7 s to a host on Tailscale, 1.3–2.1 s to a far host, measured 2026-11-18). A test run shares one connection between its test processes through `@zukhruf/testing` (#4503); an app that connects once pays it once. OpenSSH's `ControlMaster` no longer applies.
- `sshFlags` reach only `ssh -G`. A flag that changes the config (`-o`, `-i`, `-J`, `-F`, `-p`, `-l`) works as before. A flag that only changes the run of `ssh`, such as `-v`, does nothing.
- The errors change: `SshExitError` goes. The `cause` of a `ConnectionFailedError` over SSH is the error of `@zukhruf/ssh` (`AuthenticationError`, `KeyError`, `RevokedError`, `OpenChannelError`), of `ssh -G`, or of Node. [ADR 0011](./0011-only-a-failure-before-the-answer-is-a-connection-failure.md) still decides which failure is a connection failure.
- The package depends on `@zukhruf/ssh`, and through it on ssh2 and the `ssh` binary (for `ssh -G`). A consumer with npm's `strict-allow-scripts` adds `"ssh2": false` and `"cpu-features": false` to `allowScripts`.

## Amendment, 2026-11-19 (@zukhruf/ssh ADR 0013)

`SshDialer.connect` takes the connection from `config.share()` in place of `config.dial()`. With no `ControlPath`, the default, nothing changes: one SSH connection for each `Docker.connect`. With `ControlMaster auto` and a `ControlPath`, in `~/.ssh/config` or in `sshFlags`, the processes of the user share one connection to the host, as OpenSSH shares one for the Docker CLI ([ssh ADR 0013](../../../ssh/docs/adr/0013-processes-share-a-connection-by-controlmaster-and-controlpath-as-openssh-shares-one.md)). The maintainer asked for it: "why we cannot use the one ssh connection through the new ssh package?" (2026-11-19). A `Docker` disposal then ends this process's use, and the connection closes when the last process lets go. Measured on `DOCKER_CONTEXT=mac-mini` (2026-11-19, `docker:test`, interleaved): 58 s with a connection for each test, and 54–60 s with `share()`, so no faster; the run opened 11 SSH connections in place of at least 84. Sharing saves the handshake only: each `Docker.connect` still runs `docker context inspect` on the host for the engine socket (ADR 0002), as the Docker CLI runs `docker system dial-stdio` for each connection. A scratch bridge that also looked the socket up once took 30 s; that lookup is zukhruf backlog #4845.
