# A ProxyCommand runs as the transport of the connection

A user's `~/.ssh/config` can name a `ProxyCommand`: a command whose stdin and stdout carry the SSH connection. Access tools use it, such as `cloudflared access ssh`, `aws ssm start-session` and `nc` through a jump host. OpenSSH runs it as `$SHELL -c "exec <command>"`, after it expands the tokens `%h`, `%k`, `%n`, `%p`, `%r` and `%%` (ssh_config(5), `ProxyCommand` and TOKENS; `expand_proxy_command` and `ssh_proxy_connect` in `sshconnect.c`).

The probe of OpenSSH 10.5p1 on 2026-11-17 showed that `ssh -G` prints the command with its tokens: `proxycommand nc %h %p`. So the package must expand them.

A client that ignores a ProxyCommand connects straight to the hostname. That is another path, and it can be another host: the user wrote the command because the direct path is closed or is not the right one.

A ProxyCommand is a process by definition, and [ADR 0002](./0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md) removes processes that carry a connection. Its end is not the end of a helper, though. Its far end is an SSH server. When the owner dies, the kernel closes the stdin pipe of the command. A command such as `nc` passes the EOF on to the server. The server closes the connection, and the command's stdout reaches EOF, so the command exits (backlog #4503, "BOUNDARY"). This chain is a claim until a test proves it.

Ezz decided on 2026-11-17: "Run it, as OpenSSH does (Recommended)", with a test that proves that the command's process ends when the SSH server closes.

## Decision

When the route of the resolved config is `{ kind: 'proxy-command', command }`, `OpenSshConfig#dial` runs the command, and its stdin and stdout are the transport of the connection. Ezz: "Run it, as OpenSSH does (Recommended)". A test proves that the command's process ends when the SSH server closes.

- The package runs it as OpenSSH does. It expands `%h`, `%k`, `%n`, `%p`, `%r` and `%%`, and runs `<SHELL> -c "exec <command>"`, with `SHELL` of the environment, or `/bin/sh` when it is not set. The command gets the caller's environment ([ADR 0008](./0008-the-environment-and-the-clock-are-inputs.md)).
- `Client.handshake` runs on a `Duplex` made of the command's stdin and stdout.

Ezz confirmed the details below on 2026-11-17 (backlog #4503): "Confirm (Recommended)".

- The command's stderr is the stderr of the Node process, as OpenSSH leaves the command's stderr to its own, "so error messages may be printed on the user's terminal" (`ssh_proxy_connect` in `sshconnect.c`, lines 262-268 of OpenSSH 10.5p1). The package keeps no copy of it.
- On `close()`, and on an abort of the caller's signal, the client sends `SIGHUP` to the command and does not wait for it to exit. OpenSSH does the same: "Send SIGHUP to proxy command if used. We don't wait() in case it hangs" (`ssh_kill_proxy_command` in `sshconnect.c`, lines 304-313; called at the end of `ssh.c`, line 1840, and in `cleanup_exit` of `clientloop.c`, line 2891).
- A command that exits ends the connection: its stdout ends, and the client reads the end of the transport, as OpenSSH does (`client_process_net_input` in `clientloop.c`, lines 789-810). Before the handshake ends, this rejects the dial as a failure to connect.
- `ProxyCommand none` means no command, as in OpenSSH: the route is `direct`.
- `ProxyUseFdpass yes` fails the dial with an error that names the setting. This is the one part that the package cannot do as OpenSSH does. OpenSSH takes a connected socket that the command passes back over a Unix socket (`ssh_proxy_fdpass_connect` in `sshconnect.c`, lines 142-219, chosen at lines 595-597). `node:net` has no call that receives a file descriptor passed over a Unix socket (`SCM_RIGHTS`). This is a limit of the platform.

## Considered Options

- **Ignore the ProxyCommand.** The client connects to another path, or another host, with no error.
- **Fail when the config names one.** Each user of an access tool loses the package.
- **Run it, as OpenSSH does.** This option was selected.

## Consequences

- A ProxyCommand is the one process that the package runs for the life of a connection. The user's config asks for it.
- The test of this decision: a child Node process connects through a ProxyCommand (a Node relay to an SSH server that the test starts) and the parent sends it `SIGKILL`. Then the command's process ends, and the server has no open connection (`src/config-dial-route.test.ts`; the same test covers a jump host, ADR 0006).
- When the owner dies, no one sends `SIGHUP`. A command that does not pass EOF on, or that ignores the end of its stdin, can then outlive its owner. The README names this limit. Such a command is a defect of that tool, and OpenSSH has the same limit.
