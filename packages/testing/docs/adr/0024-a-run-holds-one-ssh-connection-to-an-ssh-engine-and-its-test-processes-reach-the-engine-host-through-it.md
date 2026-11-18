# A run holds one SSH connection to an SSH engine, and its test processes reach the engine host through it

A run on an SSH engine (`DOCKER_CONTEXT=mac-mini`) reaches the engine host for three things: the Engine API, the published ports of its containers (`DockerHost.forward`), and shell commands on the host (`DockerHost.shell`, for `DockerDirectory`). Before this record, `@zukhruf/docker` started one `ssh … docker system dial-stdio` process for each engine connection, and `DockerHost` started one `ssh` for each shell command and each forward (`ssh -L` with a `cat` lifeline, `@zukhruf/ssh` [ADR 0009](../../../ssh/docs/adr/0009-the-caller-forwards-a-local-port-with-node-net-and-client-dial.md)). A dead test process left `ssh` children on this machine and `dial-stdio` processes on the engine host (zukhruf backlog #4503), and the run kept forward folders and `ssh` process records so that a later run could remove them ([ADR 0006](./0006-a-killed-run-is-cleaned-by-nodes-global-setup-and-teardown.md), [ADR 0023](./0023-the-reaper-removes-the-runs-host-directories.md)).

`@zukhruf/docker` 8ca78ea8 now speaks SSH inside the Node process, with one SSH connection for each `Docker.connect` (docker [ADR 0015](../../../docker/docs/adr/0015-an-ssh-engine-is-reached-through-zukhruf-ssh-in-the-node-process.md)). One handshake to the engine host takes 0.2–0.7 s to a host on Tailscale and 1.3–2.1 s to a far host (measured 2026-11-18), and each test connects, so a connection for each test adds about 2 s to each test case.

## Decision

The maintainer decided on 2026-11-18 (#4503) that a run shares one SSH connection between all its test processes, with everything going through it ("Everything (Recommended)"), and with no timers, polls or registries ("find a way where we don't need timers, polls, set timeouts"; "we need proper mechanism").

The global setup runs in the `node --test` process for the whole run and already owns the run: `run.json`, the reaper, `DOCKER_HOST` ([ADR 0006](./0006-a-killed-run-is-cleaned-by-nodes-global-setup-and-teardown.md)). When the run's engine is an `ssh://` host, the global setup also holds the run's SSH connection:

1. `OpenSshConfig.resolve(endpoint, { environment: process.env })` and `config.dial()` of `@zukhruf/ssh/config` open one SSH connection to the engine host.
2. A session on it runs `docker context inspect --format '{{.Endpoints.docker.Host}}'`, as `@zukhruf/docker` does, for the engine socket.
3. A `node:net` server on `<run directory>/docker.sock` joins each connection to a channel of the SSH connection to the engine socket (`client.dial('unix', socket)`). The global setup sets `DOCKER_HOST=unix://<run directory>/docker.sock` for the test processes, so their docker clients use a Unix socket and open no SSH connection.
4. `ControlMaster.listen(client, '<run directory>/ssh.sock')` of `@zukhruf/ssh/control` serves the connection to the test processes ([ssh ADR 0012](../../../ssh/docs/adr/0012-a-control-master-serves-the-channels-of-one-connection-to-other-processes.md)). `DockerHost.shell` runs a session of `new ControlClient(path)`, and `DockerHost.forward` is a `node:net` server whose connections each dial `controlClient.dial('tcp', '127.0.0.1:<port>')`.

`run.json` keeps the engine's `ssh://` endpoint, so `DockerHost` and the recovery still know that the engine is remote, although `DOCKER_HOST` names a local socket.

Each lifetime is a socket that the kernel closes. A test process that dies closes its connections to the two sockets, and the global setup closes their channels; the SSH server then closes the sockets that the channels opened. A `node --test` process that dies closes the SSH connection, and the server closes every channel. The run directory is under `XDG_STATE_HOME` and belongs to the user, so only the user's processes reach the two sockets.

Outside a run (a `DockerTestbed` with no global setup), `DockerHost` opens an SSH connection of its own for the process, as `Docker.connect` does.

## Considered Options

- **A connection for each test process, or for each `Docker.connect`.** About 2 s for each test case.
- **A registry of connections in each process, kept for an idle time.** The maintainer: "no way". It is a timer and a hidden state, and the test processes still pay one handshake each.
- **OpenSSH's `ControlMaster`.** An `ssh` process carries the connection, and a dead owner reaches it only as EOF (#4503).
- **One connection for many runs, owned by an elected process.** The end of one run would cut the streams of the others.
- **The global setup holds the run's connection and serves it through a control master.** This option was selected.

## Consequences

- No test process starts `ssh`. The `cat` lifeline, the 1 s kill, the forward folders and the `ssh` process records go, and with them the parts of the recovery that removed them. With ADR 0023, a run keeps no record on this machine that the reaper cannot handle (#4508).
- The global setup needs `@zukhruf/ssh`, which already sits in the base of root ADR 0001, below `@zukhruf/testing`.
- `ssh-forward.integration.test.ts`, which drove `ssh` through a fake executable, is rewritten against an `sshd` child that bridges to the local engine, as `@zukhruf/docker`'s `ssh-transport.test.ts` does.
- The synchronous global teardown cannot wait for the SSH connection while it blocks its thread. The connection, the two servers and the master do not keep the `node --test` process alive (`unref`), and the process's end closes them.

## Amendment, 2026-11-18 (#4503 U8b)

The maintainer decided two points that the record above left open:

- **Where the sockets are.** A path in the run's directory does not fit a Unix socket's `sun_path` on macOS: `~/.local/state/zukhruf-testing/docker-runs/<uuid>/docker.sock` is 107 characters, the limit is 103, and `listen()` fails with `EINVAL`. `os.tmpdir()` is too long there too. So the global setup makes `/tmp/zukhruf-testing-<run id>/` (mode 0700, named from the run's random id, as `ssh-agent` keeps `/tmp/ssh-XXXX/agent.<pid>`) for `docker.sock` and `ssh.sock`; on Windows they are the named pipes `\\.\pipe\zukhruf-testing-<run id>-docker` and `-ssh`. The global teardown removes the folder with the run, and recovery removes it for a dead run from the id in `run.json`, so no record names it. ("/tmp/zukhruf-testing-<run id>/ (Recommended)")
- **What keeps the runner alive.** `ControlMaster` had no `unref()`; `@zukhruf/ssh` got `ControlMaster.ref()` and `unref()` (Node's `Server#ref`), and the global setup unrefs the connection, the master and the `docker.sock` server. ("Add ControlMaster.ref/unref (Recommended)")

What else the code needed:

- The reaper's socket and its host-directory folder depend on whether the engine is remote. In a run on an SSH engine, the client's host is the local `docker.sock`, so `ReaperHold.take` gets the engine's endpoint. The global setup writes that endpoint into the folder beside the sockets, and a process whose `DOCKER_HOST` is a run's `docker.sock` reads it there, with the master beside it: the connection is named by `DOCKER_HOST` alone, so a child process that a test starts with the ids of another run, as the reaper tests and the mutex matrix do, still reaches the engine host through it. A nested run is handed the engine's endpoint, so it serves a connection of its own.
- A `DockerHost` takes the path of a master or an environment: with a master it reaches the engine host only through it, and fails when the master is gone.
- A forward counts a connection that cannot reach the connection or the master as a loss of the forward, and a channel that the server refuses (a port where nothing listens yet) as no loss. `@zukhruf/ssh`'s control client rejects such a refusal with `OpenChannelError` since #4598.
- The engine socket comes from `docker context inspect` on the engine host, as `@zukhruf/docker` finds it: a copy, in the ledger of copied code.
