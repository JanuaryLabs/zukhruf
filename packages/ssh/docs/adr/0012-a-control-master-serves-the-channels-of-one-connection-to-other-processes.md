# A control master serves the channels of one connection to other processes

A test run on an SSH engine starts many test processes, and each test connects. One handshake to the engine host takes 0.2–0.7 s to a host on Tailscale and 1.3–2.1 s to a far host (measured 2026-11-18, backlog #4503), so a connection for each test adds about 2 s to each test case. A process can share one connection between its own clients, but the test processes are many processes.

An SSH connection is a TCP connection with the state of its cipher. Only one process can hold it. Another process reaches it only through the process that holds it. OpenSSH does this with `ControlMaster`: the first `ssh` holds the connection and listens on the Unix socket of `ControlPath`, and each later `ssh -S <path>` asks it for a session or a forward (`PROTOCOL.mux` of OpenSSH). The later `ssh` passes its stdin, stdout and stderr to the master as file descriptors (`SCM_RIGHTS`). Node.js cannot send a file descriptor over a Unix socket, so the package cannot speak `PROTOCOL.mux`.

The repository already ends lifetimes with sockets that the kernel closes, not with timers: a lease lasts for a session (`@zukhruf/lease`), a mutex client keeps its connection only while a request waits (`RemoteLockClient` in `@zukhruf/mutex`), and the reaper of `@zukhruf/testing` ends its run when the attach that holds it closes.

## Decision

Ezz decided on 2026-11-18 (backlog #4503) that a test run shares one SSH connection between all its test processes, through a broker in the shape of OpenSSH's `ControlMaster`, and that everything goes through it: "Everything (Recommended)". Ezz also ruled out timers, polls and idle times: "find a way where we don't need timers, polls, set timeouts", and a registry of connections in one process: "we need proper mechanism".

`@zukhruf/ssh/control` has two classes:

- `ControlMaster.listen(client, path)` listens on the Unix socket `path` and serves the channels of `client` to other processes. It is OpenSSH's `ControlMaster` and `ControlPath`. Its disposal stops the listener and closes each channel that it serves. It does not close `client`: the caller owns it.
- `new ControlClient(path)` reaches the master at `path`. It has the two calls of `Client` that open a channel: `dial(network, address)` gives a `Duplex`, and `newSession()` gives a `Session` with each of its calls (`run`, `output`, `start`, `requestPty`, `signal`, `windowChange`, `wait`). A caller that only dials and runs sessions takes a `Client` or a `ControlClient` through the same two calls.

Each channel is one connection to the Unix socket:

1. The client connects and sends one request: a dial (`tcp` or `unix`, and the address) or a session (the command or a shell, the env, the pty).
2. The master opens the channel on its connection and sends one reply: success, or the error of the open with its message and its `code`.
3. A dial then carries the bytes of the channel both ways, with no frame. The end of one side is `SSH_MSG_CHANNEL_EOF` on the other.
4. A session carries frames: stdin, the end of stdin, `window-change` and `signal` from the client; stdout, stderr and the exit (status or signal) from the master.
5. The close of the Unix connection closes the channel, and the close of the channel closes the Unix connection.

So no part of the broker waits on a timer:

- A test process that dies closes its Unix connections, and the master closes their channels. The server then closes each socket that a channel opened ([ADR 0002](./0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md)).
- A master process that dies closes the TCP connection. The server closes each channel, and the kernel closes each Unix connection, so each stream of a client fails.
- A client holds no connection between two channels. It never keeps its process alive while it has no channel, and it never has a connection to replace.

The socket gives the connection to each process that can connect to it, as OpenSSH's `ControlPath` does. The caller puts it in a directory that only its user can enter.

## Considered Options

- **A connection in each test process.** About 2 s for each test case, against one handshake for each run.
- **A registry of connections in each process, kept for an idle time.** Ezz: "no way". It is a timer and a hidden state of the module, and the test processes still pay one handshake each.
- **OpenSSH's `ControlMaster` itself.** An `ssh` child carries the connection, and a dead owner reaches it only as EOF ([ADR 0002](./0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md)). Its `PROTOCOL.mux` needs file descriptors over a Unix socket, which Node.js cannot send.
- **One connection for many runs, owned by an elected process** (the coordinator of `@zukhruf/single-flight`). The end of one run would cut the streams of the others.
- **A control master of the package, owned by the process that owns the run.** This option was selected.

## Consequences

- `@zukhruf/testing`'s global setup, which runs in the `node --test` process for the whole run, holds the connection and its master. Its test processes reach the engine, the ports of their containers and the shell of the engine host through the master. A testing ADR records this.
- A master serves only the processes that can reach its socket. A run on another computer needs its own connection.
- The protocol is the package's own, and only `ControlClient` speaks it. `ssh -S <path>` cannot use the master.
- The master runs the requests of every client as its own user on the server. A client gets nothing that the master's connection cannot do.
