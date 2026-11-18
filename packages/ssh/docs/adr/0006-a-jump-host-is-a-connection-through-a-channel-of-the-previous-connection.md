# A jump host is a connection through a channel of the previous connection

A user who reaches a server only through another server writes `ProxyJump` in `~/.ssh/config`, or gives `ssh -J`. The docker transport got this for free from `ssh` ([docker ADR 0002](../../../docker/docs/adr/0002-the-engine-is-the-one-that-the-docker-cli-selects.md)).

OpenSSH turns `ProxyJump` into a ProxyCommand that starts a second `ssh`, and it runs its own handshake over the stdin and stdout of that child (`ssh.c`, lines 1278-1326 of OpenSSH 10.5p1). For `ProxyJump j1,j2,j3` the command is `ssh [-l <user>] [-p <port>] -J j1,j2 [-F <file>] [-v] -W '[%h]:%p' j3`:

- `-l` and `-p` come only from the `ProxyJump` value. Without them, the config of the jump host gives its user and port.
- `-F <file>` comes from the caller's `-F`, when the caller gave one. `-v` comes from the caller's `-v`, and changes only the debug output. No other flag of the caller reaches the jump host. Its `-o` flags do not.
- The last jump host gets the earlier jump hosts as `-J`. Its own `ssh` does the same with them, so the chain is j1, then j2, then j3, then the destination.
- A `-J` flag sets the ProxyCommand to `none` before `ssh` reads the config file, and OpenSSH uses the first value that it gets (`parse_jump` in `readconf.c`). So the `ProxyJump` and the `ProxyCommand` that the config gives to j2 or j3 are not used. Only j1 starts with no `-J`, so only the first jump host follows its own `ProxyJump` or `ProxyCommand`.
- `%h` and `%p` are the hostname and the port of the next host, after its config resolved them.
- OpenSSH checks one loop: a jump host with the same host, port and user as its destination fails with "jumphost loop".

What the leaders do (research `~/.claude/plans/zukhruf-ssh-4503-research.md`, steps 2 and "Boundary"):

- **Go**: `jump.Dial("tcp", target)` opens a `direct-tcpip` channel. `ssh.NewClientConn(conn, addr, config)` runs the handshake on it, and `ssh.NewClient` makes the client.
- **Rust**, russh: `connect_stream` runs the handshake on a stream, such as a channel of another client (`client/mod.rs:844-1208`).
- **.NET**, SSH.NET: no jump host (issues #481, #530).
- **VS Code**: resolves the config with `ssh -G`, connects with ssh2, and for `ProxyJump` spawns `ssh -J … -W` (`sshProxyJump.ts:107-114`).

A probe of OpenSSH 10.5p1 on 2026-11-17: `ssh -G -J alice@jump1:2200,jump2 example.invalid` printed `proxyjump alice@jump1:2200,jump2`.

## Decision

Ezz accepted this decision on 2026-11-17, together with [ADR 0009](./0009-the-caller-forwards-a-local-port-with-node-net-and-client-dial.md) (backlog #4503): "Accept both (Recommended)".

A jump host is a client, and the next client runs its handshake on a channel that the jump host's client dialed. No process carries the connection to a jump host.

- `Client.handshake(transport, address, config)` of the root import path runs the handshake on a stream that the caller gives. It is Go's `NewClientConn` and `NewClient` in one call. `Client.dial(address, config)` opens a TCP connection with `node:net` and calls it.
- `OpenSshConfig.resolve` resolves each jump host of a `ProxyJump` value by its own `ssh -G`, as OpenSSH starts the jump host's `ssh`: with `-l` and `-p` when the value gives them, with the caller's `-F <file>` when the caller gave one, and with no other flag of the caller, such as its `-o` flags. The route of the destination is `{ kind: 'jump', jumpHosts }`, with the jump hosts in the order of the value. The first is a `FirstJumpHost`, which has its own route. Each later one is a `JumpHost`, which has no route: the package reads no `proxyjump` and no `proxycommand` from its `ssh -G`.
- `OpenSshConfig#dial` reaches the first jump host by the route of that jump host: `direct`, `jump` or `proxy-command`. Then it dials each next jump host, and last the destination, through the client before it with `client.dial('tcp', 'host:port')`, and runs the next handshake on that channel. `host:port` is the hostname and the port of the resolved config of that host.
- The type `readonly [FirstJumpHost, ...JumpHost[]]` has no place for the route of a later jump host, because OpenSSH does not use it. A route that nothing reads cannot exist.
- A loop fails, such as a first jump host whose own route comes back to it: `resolve` rejects with `jumphost loop via <host>`, OpenSSH's words. A jump host with the same host, port and user as its destination fails in its own `ssh -G`, with exit code 255.
- Each jump host and the destination check their own host key, with their own name ([ADR 0005](./0005-host-keys-are-checked-as-gos-knownhosts-checks-them-under-openssh-stricthostkeychecking.md)).
- The client of the destination owns the clients of its jump hosts. Its close closes them after it, from the last jump host back to the first.
- The rule above comes from `ssh.c` and `readconf.c` of OpenSSH 10.5p1. A test of the build compares it with what `ssh -v` logs before the code depends on it.

## Considered Options

- **VS Code's `ssh -J … -W` child.** It is a helper process. [ADR 0002](./0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md) rejects it.
- **No jump host.** SSH.NET has none. A user whose `~/.ssh/config` has `ProxyJump` then gets a connection to the wrong host, or none.
- **A `ProxyJump` option in the root `ClientConfig`.** Go keeps the handshake on a stream as its own call, so a caller can put any stream under a client. The config subpath composes it.
- **Go's `NewClientConn` on a channel of the previous client.** This option was selected.

## Consequences

- The death of the owner ends the whole chain. The kernel closes the TCP connection to the first jump host. That server closes its `direct-tcpip` channel and the socket to the next host, and so on to the destination. A test proves it through one jump host: `SIGKILL` of the owner leaves no process, and no open channel on the jump host or on the destination.
- Each jump host adds one SSH layer of encryption on the path, as `ssh -W` does.
- Of the caller's flags, only `-F` reaches a jump host. A setting for a jump host goes in its `Host` block of the config file, as for OpenSSH.
