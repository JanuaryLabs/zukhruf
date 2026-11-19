# Processes share a connection by ControlMaster and ControlPath, as OpenSSH shares one

`@zukhruf/docker` opens one SSH connection for each `Docker.connect`, and each docker test connects. On `DOCKER_CONTEXT=mac-mini`, a connect costs 0.6–1.0 s (the handshake about 250 ms, the `docker context inspect` session about 350 ms), and `docker:test` takes 55 s. A scratch bridge that gave the whole run one connection took 30 s (measured 2026-11-19). Parallel handshakes also hit sshd's `MaxStartups 10:30:100`, which drops connections at random (zukhruf backlog #4557).

[ADR 0012](./0012-a-control-master-serves-the-channels-of-one-connection-to-other-processes.md) gave the package a control master, and `@zukhruf/testing` holds one in its global setup for a run. A package that `@zukhruf/testing` depends on cannot use that global setup, and the maintainer wants no more global setup files: "fuck the global files. I would hopefuly remove them at some point. why we cannot use the one ssh connection through the new ssh package?" (2026-11-19). The design follows the leading tool, as the maintainer asked: "I want to do not opinionated. I would like to follow the top performers."

## Decision

`OpenSshConfig#share()` gives a connection that the processes of the user share, by the `ControlMaster` and `ControlPath` that `ssh -G` resolves ([ADR 0004](./0004-openssh-resolves-the-config-through-ssh-g.md)). It ports OpenSSH's own algorithm (openssh-portable master fa4b2a82be, 2026-11-18):

- **Join** (`muxclient`, mux.c): connect to the socket. With nothing there (`ENOENT`), become the master. A socket that refuses connections (`ECONNREFUSED`) is stale: `auto` removes it and becomes the master. A peer that sends no hello is no master: keep a connection of this process alone. The hello waits at most `ConnectTimeout`, as `mux_client_hello_exchange` does; with no `ConnectTimeout`, it waits as long as OpenSSH waits.
- **Become the master** (`muxserver_listen`, mux.c): listen on a name of its own, then `link()` the socket to it, so no process connects to a socket that does not listen yet. When the link finds the socket taken (`EEXIST`), another process won: keep a connection of this process alone.
- **Lifetime** (`client_loop` in clientloop.c, `channel_still_open` in channels.c): the master serves while this process uses the connection, or while another process holds a connection to the master or a channel through it. OpenSSH counts each mux client's connection (`SSH_CHANNEL_MUX_CLIENT`) as open. Each connection that the master serves keeps its process alive, and its listener does not. So a master's process stays until the last process that uses it lets go, as OpenSSH's first `ssh` stays. No timer is in it: `ControlPersist` is a timer, and the maintainer rules out timers ([ADR 0012](./0012-a-control-master-serves-the-channels-of-one-connection-to-other-processes.md)).
- `ControlMaster no` only joins, `yes` only becomes the master, and `auto` does both. `ask` and `autoask` confirm each use through `ssh-askpass`: `share()` rejects them, as `dial()` rejects `ProxyUseFdpass yes`. `ControlPath none` turns sharing off.
- A joined connection holds one connection to the master from `share()` to `close()`. Its hold keeps its process alive only while ref'd, and its channels never do, so an idle `Docker` does not keep its process alive. It starts ref'd, as a `Client` does.

`dial()` does not change: it is a connection of its own, as `ssh -S none` is. The explicit `ControlMaster.listen` and `ControlClient` of ADR 0012 stay for a process that chooses the owner itself.

A caller turns sharing on in `~/.ssh/config`, as Docker's docs advise for the Docker CLI, or with flags: `OpenSshConfig.resolve(host, { flags: ['-o', 'ControlMaster=auto', '-o', 'ControlPath=~/.ssh/cm-%C'] })`. `ssh -G` expands the tokens of `ControlPath`.

## Considered Options

- **A global setup that holds the run's connection** (as `@zukhruf/testing`'s). The maintainer rules out more global setup files.
- **A helper process that carries the connection** (OpenSSH's `ControlPersist` forks one). [ADR 0002](./0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md): no helper process carries a connection. Its lifetime is also a timer.
- **A registry of connections in each process.** The maintainer: "no way" (ADR 0012). The processes still pay one handshake each.
- **The master in the first process that dials, as OpenSSH's.** Selected.

## Consequences

- The socket is `ControlPath` with `.zukhruf` after it, as the maintainer chose on 2026-11-19 ("Keep `.zukhruf` suffix"), when no leading tool had a case to copy. The package's protocol is not OpenSSH's `PROTOCOL.mux` (ADR 0012), so its master never takes the socket of an OpenSSH master, and the two never meet. Both send a hello first, and each side fails at the first byte that is not its own, so a wrong peer gives a connection of its own, not an error.
- A process that is the master does not exit while another process uses it. `node --test --test-force-exit` kills a test process when its file ends, and the other files then lose their channels: a test target that shares must run without `--test-force-exit`.
- After `close()` the master serves until its last connection ends. Then it removes the socket, closes its listener in the same turn of the event loop, and closes the connection. A master that is killed leaves its socket, which the next `auto` removes.
- A master that dies ends each stream that goes through it with an error, as OpenSSH's mux clients end with their master.
