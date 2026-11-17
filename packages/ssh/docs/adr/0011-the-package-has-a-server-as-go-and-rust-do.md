# The package has a server, as Go and Rust do

SSH has two sides, and the leaders differ on whether one package gives both (research `~/.claude/plans/zukhruf-ssh-4503-research.md`, "Boundary"):

- **Go**, `golang.org/x/crypto/ssh`: one package. `NewServerConn(conn, config)` runs the server side of the handshake on a `net.Conn` that the caller accepted (`server.go:356`). It gives the incoming channels and the global requests as Go channels, and the caller accepts or rejects each one. `ServerConfig` holds the host keys and the auth callbacks.
- **Rust**, russh: one crate with a `client` module and a `server` module.
- **.NET**, SSH.NET: a client only.

The two sides share the transport, the key exchange, the keys and the messages. ssh2 also gives both: `Server` (`server.js:217`) with `injectSocket` for a socket that the caller accepted (`server.js:361`), and on the server side `forwardOut` and `openssh_forwardOutStreamLocal` for forwarded channels (`server.js:1295`, `:1301`).

The first draft of the research map put "a server" under "never" (research, step 2). The rule that Ezz gave for the scope forbids a cut for "no consumer yet" ([ADR 0001](./0001-the-scope-and-the-name-of-gos-ssh-package.md)). On 2026-11-17 he chose "Include the server (Recommended)".

## Decision

The package has a server, as Go and Rust do. Ezz: "Include the server (Recommended)".

The server is in the root import path, as Go's `NewServerConn` is in its `ssh` package. The four import paths that Ezz accepted ([ADR 0001](./0001-the-scope-and-the-name-of-gos-ssh-package.md)) have no other place for it.

The shape of the server API is Go's. Ezz chose it on 2026-11-17: "Accept, Go's shape (Recommended)". He accepted three refinements the same day ("Accept (Recommended)"): `ServerConfig` has no clock, only a `tcpip-forward` request accepts with a port, and the `'unix'` form of `forward` takes no origin.

- `ServerConn.handshake(transport, config)` runs the server side of the handshake on a stream that the caller accepted, such as a socket of a `node:net` server. It is Go's `NewServerConn`. The package opens no listener of its own.
- `ServerConfig` has the host keys and the auth callbacks (`publicKey`, `password`, `keyboardInteractive`). It is Go's `ServerConfig`, which has no clock either. The server waits on no timer of its own ([ADR 0008](./0008-the-environment-and-the-clock-are-inputs.md)).
- `serverConn.channels()` gives each incoming channel: a session, `direct-tcpip` or `direct-streamlocal@openssh.com`. The caller accepts or rejects it.
- `serverConn.requests()` gives each global request: `tcpip-forward`, `streamlocal-forward@openssh.com` and their cancels. The caller accepts or rejects it. Only a `tcpip-forward` accepts with a port, the port that the server bound for port 0 (RFC 4254 §7.1); a cancel accepts with none. `serverConn.forward('tcp', address, origin)` and `serverConn.forward('unix', path)` open the forwarded channel to the client for each connection that it accepts. A `forwarded-streamlocal@openssh.com` channel carries no origin (OpenSSH `PROTOCOL` §2.4), so the `'unix'` form takes none.
- A session channel gives its requests (`env`, `pty-req`, `window-change`, `signal`, `exec`, `shell`, `auth-agent-req@openssh.com`), its stdin, stdout and stderr, and `exit(status)`.

## Considered Options

- **A client only, as .NET.** A program that must answer SSH, such as a test server, a sandbox that a person reaches with `ssh`, or a Git server, then uses ssh2 directly, beside this package.
- **A server in its own package.** Go and Rust keep one package, because the two sides share the transport, the keys and the messages. Two packages would share them through a third.
- **A server in the same package, as Go and Rust.** This option was selected.

## Consequences

- The tests of the package run a real server in their own process. CI has no `mac-mini`, so a test of the client needs a server that it starts itself. The suites that need OpenSSH's own behaviour, such as `session_close_by_channel`, still run against an sshd container.
- `@zukhruf/docker` can replace its fake `ssh` binary (`packages/docker/src/testing/ssh-stand-in.ts`) with a real server in its tests.
- The server has no timer of its own. A caller limits a slow handshake with the signal of `ServerConn.handshake`, in place of sshd's `LoginGraceTime`.
