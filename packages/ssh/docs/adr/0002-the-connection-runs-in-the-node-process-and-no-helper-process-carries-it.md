# The connection runs in the Node process, and no helper process carries it

`@zukhruf/docker` reaches an `ssh://` engine through a helper process: one `ssh … docker system dial-stdio` for each connection (`packages/docker/src/ssh-connection.ts:45`, [docker ADR 0002](../../../docker/docs/adr/0002-the-engine-is-the-one-that-the-docker-cli-selects.md), [docker ADR 0010](../../../docker/docs/adr/0010-ssh-gets-the-options-of-the-docker-cli-and-the-flags-of-the-caller.md)). On 2026-11-17, 203 such `ssh` processes ran on the laptop under launchd, and about 170 connections of `docker system dial-stdio` ran on the engine's host (backlog #4503).

A probe measured when the helper outlives its owner (session cb170ced, `probe-4503/{parent,child}.ts`). A child Node process used the real `@zukhruf/docker` against `ssh://ezzabuzaid@mac-mini`. The parent ended the child and looked at the child's `ssh` processes 15 s later:

| The owner ends by | Case                                                         | Local `ssh` 15 s later                |
| ----------------- | ------------------------------------------------------------ | ------------------------------------- |
| normal exit       | idle keep-alive connection                                   | exited                                |
| `SIGKILL`         | idle connection                                              | exited                                |
| `SIGKILL`         | `events()` stream                                            | exited                                |
| `SIGKILL`         | `spawn(['sleep','600'])` exec, with and without stdin        | alive                                 |
| `SIGKILL`         | `attach()` to a container that runs `sleep 600`              | alive (its 2 idle connections exited) |
| `SIGKILL`         | the `EngineLease` shape (`busybox cat -`, stdin, AutoRemove) | exited, container removed             |

The root cause, measured on the same day (backlog #4503, "ROOT CAUSE"):

1. Each program on the path between the Node process and the engine passes the end of a connection on as EOF, a half-close, and never as a full close. The OpenSSH client turns EOF of its stdin into channel EOF. sshd and Tailscale SSH turn channel EOF into EOF of the command's stdin. `docker system dial-stdio` turns EOF of its stdin into `CloseWrite`. So a dead owner and the end of input look the same to the engine.
2. The engine ends a normal request on that EOF. A hijacked exec or attach takes it as the end of its input only, and stays open until the container's process writes or ends ([docker ADR 0005](../../../docker/docs/adr/0005-output-is-one-stream-of-chunks-and-only-a-close-ends-the-input.md)).
3. Each program on the path that runs as a process waits for that stream. The OpenSSH client does not exit while a channel is open. sshd does not end a command without a pty when its client is gone: `session_close_by_channel` in OpenSSH's `session.c` only closes the pipes. A Tailscale SSH `dial-stdio` (PID 92759) lived on with PPID 1.

Over a Unix socket the engine gets the same EOF, but the connection is a kernel object of its owner. The owner's death closes it, and no process is left to leak. docker/cli has the same leak on macOS: `cli/connhelper/commandconn/pdeathsig_linux.go` sets `Pdeathsig = SIGKILL` on the `ssh` child, and `pdeathsig_nolinux.go` does nothing. Node's `spawn` has no parent-death signal.

Podman's remote client has no helper process. It keeps one SSH connection in its process with `golang.org/x/crypto/ssh`, and it dials the engine socket for each HTTP connection over `direct-streamlocal@openssh.com` (`pkg/bindings/connection.go`; `common/pkg/ssh/utils.go`, `sshClient.DialContext(ctx, mode, url.Path)`). When the server refuses that channel, it runs `docker system dial-stdio` on a session of the same connection (`connection_stdio.go`, commit `ee681f80e9`).

Ezz first asked for the root cause: "take a step back, find root cause and let us fix it from ground up". The choice was then between an OpenSSH child that a local watchdog kills when its owner dies, and SSH in the process. Ezz decided on 2026-11-17 (backlog #4503): "Dude, I don't care how long the work takes. I have plenty of time. We need to do the proper one."

## Decision

The SSH connection runs inside the Node process, with no helper process and no watchdog.

- A client is one TCP connection of the Node process. The protocol runs in that process ([ADR 0003](./0003-ssh2-speaks-the-protocol.md)).
- A stream to a remote socket is a channel of that connection (`client.dial('unix', path)` or `client.dial('tcp', address)`), not a remote process.
- When the owner dies, also by `SIGKILL`, the kernel closes its TCP connection. The SSH server then closes each channel and each socket that a channel opened. No process is left on either machine. This is the guarantee of a Unix socket.
- No part of the package starts a process that lives as long as a connection, with one exception that the user's own config asks for: a ProxyCommand ([ADR 0010](./0010-a-proxycommand-runs-as-the-transport-of-the-connection.md)). `ssh -G` runs for a short time before the connection opens ([ADR 0004](./0004-openssh-resolves-the-config-through-ssh-g.md)).

## Considered Options

- **An OpenSSH child for each client, killed by a local watchdog when its owner dies** (docker/cli's `Pdeathsig` on each POSIX system, through a pipe that a small `sh` reads). It lost: it adds machinery to clean up after a process that need not exist. With `dial-stdio`, the remote `dial-stdio` still lives on. Ezz's words above choose "the proper one", and this reason is the ADR's own.
- **Keep `dial-stdio`, and add a parent-death signal.** The local `ssh` dies, but the remote `dial-stdio` stays for a silent hijacked stream, as PID 92759 showed.
- **One OpenSSH child that forwards the engine socket with `-L`**, ended by the remote-cat lifeline of `packages/testing/src/docker/host.ts`. The lifeline ends `ssh` only when no forwarded channel is half-open. A probe saw `ssh` 31173 stay after its remote `cat` exited, because it held the dead owner's forwarded connection.
- **OpenSSH connection sharing (`ControlMaster`).** The master is itself a process that outlives its clients.
- **SSH in the Node process, as Podman does.** This option was selected.

## Consequences

- Two probes proved the guarantee before the decision (`probe-4503/inproc.ts`, `child-inproc.ts`). ssh2 in Node reached Tailscale SSH on mac-mini with agent auth and a host key checked against `ssh-keygen -F mac-mini`. `GET /_ping` over `direct-streamlocal` to `/Users/ezzabuzaid/.docker/run/docker.sock` gave `HTTP/1.1 200 OK`, Docker 29.9.2, API 1.56. Then a child process held an attach with stdin to a silent `sleep 600` container, and the parent sent `SIGKILL`. Local processes left: 0. Processes under `tailscaled` on the Mini: 165 before, 165 with the attach open, 165 after.
- The engine still keeps a silent attach after its client is gone. A local Unix-socket client on the Mini saw the same (`probe-4503/baseline.mjs`), so this is the engine's behaviour, not a leak of the transport.
- The package must give what OpenSSH gave for free: the config of `~/.ssh/config` ([ADR 0004](./0004-openssh-resolves-the-config-through-ssh-g.md)), the known hosts ([ADR 0005](./0005-host-keys-are-checked-as-gos-knownhosts-checks-them-under-openssh-stricthostkeychecking.md)), the agent and the identity files, and jump hosts ([ADR 0006](./0006-a-jump-host-is-a-connection-through-a-channel-of-the-previous-connection.md)).
- A server can refuse `direct-streamlocal` for a path. Tailscale SSH allows it only under the user's home, `/tmp` and `/run/user/<uid>` (`ssh/tailssh/fwdmonitor.go`, `fwdAllowedSocketPath`), so it refuses a rootful engine at `/run/docker.sock`. `@zukhruf/docker` then refuses with a clear error that names the server's refusal and the fixes: rootless Docker, whose socket is under `/run/user/<uid>`, or an OpenSSH server. It does not run `docker system dial-stdio` on a session, as Podman does, because that remote process can outlive a dead owner for a silent hijacked stream. Ezz decided this on 2026-11-17 (backlog #4503): "Refuse with a clear error".
- The black-box test of the guarantee: a child process holds an attach to a silent container through the client, the test sends `SIGKILL`, and then no process is left and the server has closed the engine socket.
- The 164 orphans of the old transport stay on the laptop as evidence until the fix is released. Then they are killed by their exact PIDs, and their far ends are checked (Ezz, 2026-11-17: "Yes, after the release").
