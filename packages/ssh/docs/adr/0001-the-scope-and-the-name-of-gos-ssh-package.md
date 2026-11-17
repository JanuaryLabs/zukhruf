# The scope and the name of Go's ssh package

Five places in four files open SSH connections, and each one starts the OpenSSH binary (research `~/.claude/plans/zukhruf-ssh-4503-research.md`, step 1, "strike 5"). The "BOUNDARY" note of backlog #4503 counts four places, because it does not list `run-cleanup.ts`:

- `packages/docker/src/ssh-connection.ts`: the engine transport, one `ssh … docker system dial-stdio` process for each connection.
- `packages/testing/src/docker/host.ts`: `shell()` runs a command, and `forward()` runs `ssh -L` with a remote `cat`.
- `packages/testing/src/scripts/run-cleanup.ts`: `execFileSync('ssh', …)` removes the remote directories of a run.
- text2sql `infra/dokploy/seed/box.ts`: `ssh()` and `streamToBox()` run commands on the box.

None of our repositories has an SSH client in the process (zukhruf, deepagents, sdk-it, elt). Node v26.13.0 has no SSH module. So the knowledge has five places, past the third place of the Rule of Three ([root ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md), rule 2), and it moves into one package. [ADR 0002](./0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md) says why that package speaks SSH itself.

Ezz gave the rule for the scope on 2026-11-17: "you can do it now. but I want you first to learn our princple of forcing thr host into the package design not the host forcing the packge design. we need to learn from lanagues such as go, rust and c#. if is package belong in another one or subset of bigger one then we should see this now". So the scope comes from the libraries of those languages, read in their source on 2026-11-17 (research, "Boundary"):

- **Go**, `golang.org/x/crypto/ssh`: its own package in the `x/crypto` module. One package has the client and the server (`NewServerConn`, `server.go:356`). The client has `Dial`, `DialContext` and `DialTCP` (`tcpip.go:380-461`), `Listen` and `ListenTCP` (`tcpip.go:29`, `:116`) and `ListenUnix` (`streamlocal.go:34`). A session has `Setenv`, `RequestPty`, `WindowChange`, `Signal` and `Shell` (`session.go:167-357`). The subpackage `ssh/agent` has the agent client and agent forwarding (`agent/forward.go:19-58`). The subpackage `ssh/knownhosts` checks host keys. SFTP is another module, `github.com/pkg/sftp`.
- **Rust**, russh: one crate with the client, the server, the keys, the agent and known_hosts. The client has `channel_open_session`, `channel_open_direct_tcpip`, `channel_open_direct_streamlocal`, `tcpip_forward`, `streamlocal_forward` and `connect_stream` for a jump host (`client/mod.rs:844-1208`). SFTP is another crate, russh-sftp.
- **.NET**, SSH.NET 2026.0.1: one package with `SshClient`, `ForwardedPortLocal`, `ForwardedPortRemote`, `ForwardedPortDynamic`, `SftpClient`, `ScpClient` and `NetConfClient`. It is a client only. It has no streamlocal channel (issue #238), no jump host (#481, #530) and no known_hosts reader. The .NET standard library has no SSH.

None of the three puts SSH inside a networking package or a remote-access package. No zukhruf package fits either: `@zukhruf/pipes` is local IPC after `System.IO.Pipes`, `@zukhruf/docker` speaks the Engine API, and `@zukhruf/testing` is the tool layer.

## Decision

Ezz decided on 2026-11-17 (backlog #4503): the package is public ("Public (Recommended)"), and its name and its four import paths are as proposed ("Accept as proposed (Recommended)" for `@zukhruf/ssh`, `@zukhruf/ssh/agent`, `@zukhruf/ssh/knownhosts` and `@zukhruf/ssh/config`). He ruled on the server and the ProxyCommand later, in [ADR 0011](./0011-the-package-has-a-server-as-go-and-rust-do.md) and [ADR 0010](./0010-a-proxycommand-runs-as-the-transport-of-the-connection.md).

- The package is `@zukhruf/ssh`, after Go's `ssh` package. It is public, because the public `@zukhruf/docker` will depend on it. It is its own package in `packages/ssh`, not part of another package.
- Its layer is base, with the tags `layer:island` and `std:base`. `@zukhruf/docker` is a base package and will import it, and a base package imports only Node, base packages and npm packages ([root ADR 0001](../../../../docs/adr/0001-zukhruf-is-a-layered-standard-library.md)).
- Its scope is SSH at full strength, as Go and Rust give it, and not the part that today's callers use:
  - the client: dial, handshake on a given transport, sessions, `dial('tcp' | 'unix', address)`, `listen('tcp' | 'unix', address)`, close;
  - sessions: run, start, wait, output, stdin, stdout and stderr, `setenv`, `requestPty`, `shell`, `windowChange`, `signal`, the exit status and `ExitError`;
  - jump hosts in the process ([ADR 0006](./0006-a-jump-host-is-a-connection-through-a-channel-of-the-previous-connection.md));
  - the server ([ADR 0011](./0011-the-package-has-a-server-as-go-and-rust-do.md)).
- Its import paths follow Go's subpackages:
  - `@zukhruf/ssh`: `Client`, `ClientConfig`, `Session`, `RemoteListener`, `PublicKey`, `PrivateKey`, `ServerConn`, `ServerConfig`, and agent forwarding (`ClientConfig.agentForwarding`). Go puts agent forwarding in `ssh/agent` (`agent.ForwardToRemote`, `agent.RequestAgentForwarding`). Here it is in the root import path, because ssh2 takes the agent and `agentForward` when it connects (ssh2 1.17.0, `client.js:219-225`), so the client config must carry it;
  - `@zukhruf/ssh/agent`: `AgentClient`, the client of an agent on a socket that the caller connects (Go's `agent.NewClient`). The preview that Ezz accepted listed `./agent` as `AgentClient`;
  - `@zukhruf/ssh/knownhosts`: `KnownHosts`, `KeyError` and `RevokedError` (Go's `ssh/knownhosts`);
  - `@zukhruf/ssh/config`: the OpenSSH config of a destination, resolved by `ssh -G` ([ADR 0004](./0004-openssh-resolves-the-config-through-ssh-g.md)). Go has no such subpackage. Tools do it: VS Code, distant, zed.
- The names follow Go. `Client.dial(address, config)` is Go's `ssh.Dial`, and `ClientConfig` is Go's `ssh.ClientConfig`. The package has no type named `Connection`: in Go, `ssh.Conn` is the layer under `ssh.Client`.
- SFTP is out. Go and Rust give it in a separate package, because it is a subsystem protocol with its own draft.

## Considered Options

- **A part of `@zukhruf/docker`.** Testing and text2sql open SSH connections with no Docker engine: a shell, a port forward, a seed stream. They would import Docker to get SSH.
- **The slice that today's callers use**: connect, `dialUnix`, `dialTcp`, `exec` and close (the first boundary in backlog #4503). The names say who called them, not what SSH does. The first draft of the research map put remote listeners, ptys and agent forwarding under "later" for "no consumer yet" (research, step 2), and the rule above forbids that reason.
- **.NET's scope**: a client with forwarder classes, SFTP and SCP. SSH.NET has no streamlocal and no jump host, which the docker transport needs ([ADR 0002](./0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md)). SFTP is a protocol of its own.
- **Go's and Rust's scope, in its own package.** This option was selected.

## Consequences

- The package has the scope of the domain before its first consumer moves to it. Each consumer follows the package ([What each repository changes](../../README.md#what-each-repository-changes)).
- The import path `./config` is the one part that no library of the three has. It depends on the OpenSSH binary, and the other paths do not.
- SFTP, if a consumer needs it, is a new package beside this one.
