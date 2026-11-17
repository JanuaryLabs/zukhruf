# SSH

A Node process speaks SSH itself: it connects to an SSH server, runs commands, and opens streams to sockets on the remote host. It can also be the server. The words come from the SSH RFCs (RFC 4251 to 4254), from OpenSSH, and from Go's `golang.org/x/crypto/ssh`, which gives the names of the types.

## Language

### The connection

**Client**:
One SSH connection from this process to an SSH server, and the channels on it. A `Client` comes from `Client.dial`, `Client.handshake` or `OpenSshConfig#dial`. Go's `ssh.Client`.
_Avoid_: Connection (Go's `ssh.Conn` is the layer under the client), SSH session (a session is one channel), tunnel

**Client config**:
What a client needs for its handshake and its sessions. Go's `ssh.ClientConfig`. Its fields:

- `user`, `auth` (the auth methods), `hostKey` (the host key callback) and `clock`: required.
- `hostKeyAlgorithms`: the host key algorithms to offer, in order.
- `connectTimeout` and `keepalive`: off when absent.
- `agentForwarding`: when set, every session asks for agent forwarding, and each channel of agent forwarding gets a new connection to the agent from it.
- `sessionEnv`: the `env` requests that each new session sends before its first other request.

_Avoid_: Options, connection settings, profile

**Address**:
Where a TCP connection or a channel goes. For `'tcp'` it is `host:port`, with brackets around an IPv6 host. For `'unix'` it is the path of a socket on the remote host. Go's `addr` argument of `ssh.Dial` and `Client.Dial`.
_Avoid_: Destination, target, endpoint

**Destination**:
What a person gives to `ssh`: `[user@]hostname[:port]`, an `ssh://` URI, or a `Host` name of `~/.ssh/config`. `ssh -G` resolves it to a hostname, a port and a user. OpenSSH's word (ssh(1), SYNOPSIS).
_Avoid_: Host (OpenSSH's `Host` is a pattern in the config), address

**Transport**:
The byte stream under the SSH protocol: a TCP socket, a channel of a jump host's client, or the pipes of a ProxyCommand. RFC 4253 calls the layer above it the transport layer protocol.
_Avoid_: Socket (only one of the three kinds), connection, tunnel

**Handshake**:
The start of a connection on a transport: the version exchange, the key exchange (RFC 4253 §7) and the user authentication (RFC 4252). Go's `ssh.NewClientConn` and `ssh.NewServerConn` run it.
_Avoid_: Login, connect

**Channel**:
One stream inside a connection, with its own flow control (RFC 4254 §5). A session, a `direct-tcpip` stream and a `direct-streamlocal@openssh.com` stream are channels.
_Avoid_: Tunnel, pipe, connection

**Session**:
A channel that runs one command or one shell on the remote host (RFC 4254 §6). Go's `ssh.Session`. Its stdin, stdout and stderr are the data of the channel.
_Avoid_: Exec, process, command, SSH session (for the whole connection)

**Exit status**:
The number that a session's command exits with, sent as the `exit-status` request (RFC 4254 §6.10). A command that a signal ended sends `exit-signal` instead.
_Avoid_: Exit code (Node's word for a local process), return code

**End of input**:
The end of the stdin of a session or of the write side of a dialed stream. The client sends `SSH_MSG_CHANNEL_EOF` (RFC 4254 §5.3). The channel stays open for the output.
_Avoid_: Close (a close ends both directions), EOF alone

**Dial**:
To open a stream through the server to an address that the server can reach: a `direct-tcpip` channel for `'tcp'` (RFC 4254 §7.2) or a `direct-streamlocal@openssh.com` channel for `'unix'` (OpenSSH `PROTOCOL` §2.4). Go's `Client.Dial`.
_Avoid_: Forward (OpenSSH's `-L` is a dial plus a local listener), tunnel, connect

**Remote listener**:
A socket that the server listens on for the client, after a `tcpip-forward` (RFC 4254 §7.1) or `streamlocal-forward@openssh.com` request. Each connection to it comes to the client as a channel. OpenSSH's remote forwarding (`ssh -R`). Go's `Client.Listen` gives it as a `net.Listener`.
_Avoid_: Reverse tunnel, remote forward (the OpenSSH flag, not the object)

**Jump host**:
A server that the client connects to first, and that dials the next server for it. The next client runs its handshake on that dialed channel. OpenSSH's `ProxyJump` (`ssh -J`). In a resolved config, the first jump host is a `FirstJumpHost`: it follows its own `ProxyJump` or `ProxyCommand`. Each later jump host is a `JumpHost`, with no route: OpenSSH reaches it through the jump host before it (`parse_jump` in `readconf.c`).
_Avoid_: Bastion (a role, not the mechanism), proxy, hop

**ProxyCommand**:
A command of the user's config whose stdin and stdout are the transport of the connection. OpenSSH runs it as `$SHELL -c "exec <command>"`. ssh_config(5), `ProxyCommand`.
_Avoid_: Proxy, helper, connection helper (the Docker CLI's word for a whole `ssh` process)

**Helper process**:
A process that carries a connection for its owner and can outlive it, such as an `ssh` child that runs `docker system dial-stdio`. The package has none ([ADR 0002](./docs/adr/0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md)). Ours, not an industry term.
_Avoid_: Sidecar, child (any child), watchdog (a second process that kills the first)

**Keepalive**:
A `keepalive@openssh.com` global request that the client sends at each interval, also when data came from the server. The count of requests with no answer resets only on an answer to a keepalive, or on the success or failure of a channel request, and not on other data (ssh2 1.17.0, `client.js:646`, `:656`, `:735-742`). After `countMax` requests with no answer, the client ends the connection. OpenSSH's `ServerAliveInterval` and `ServerAliveCountMax`, but OpenSSH sends a request only after an interval with no data from the server (`client_process_net_input` in `clientloop.c`).
_Avoid_: Heartbeat, ping, TCP keepalive (a socket option of the kernel)

**Connect timeout**:
The limit for the TCP connect, the banner exchange and the key exchange. It does not apply after them. OpenSSH's `ConnectTimeout` ("applied both to establishing the connection and to performing the initial SSH protocol handshake and key exchange", ssh_config(5)).
_Avoid_: Timeout (alone), ready timeout (ssh2's `readyTimeout` also covers the authentication)

### Host keys

**Host key**:
The public key that the server signs the key exchange with. The client checks it before it sends a credential (RFC 4253 §8).
_Avoid_: Server key, fingerprint (a hash of the key)

**Host key callback**:
The function of the client config that gets the hostname, the port and the host key during the handshake, and throws to refuse the key. Go's `ssh.HostKeyCallback`. It has no default.
_Avoid_: Host verifier (ssh2's word), trust callback

**Known hosts**:
The files that list the host keys a user trusts: `UserKnownHostsFile` and `GlobalKnownHostsFile`. A line holds host patterns, or a hashed name (`|1|`), and a key. A line can start with `@revoked` or `@cert-authority`. sshd(8), section SSH_KNOWN_HOSTS FILE FORMAT. Go's `ssh/knownhosts`.
_Avoid_: Trust store, fingerprint list

**Known key**:
One key of the known hosts for a host, with its file and line. Go's `knownhosts.KnownKey`.
_Avoid_: Trusted key, pinned key

**Revoked key**:
A key on an `@revoked` line. Go's `knownhosts.RevokedError` reports it. The client refuses it under `StrictHostKeyChecking` `yes`, `ask` and `accept-new`. Under `no`, it connects in the restricted mode of a changed key, as OpenSSH does (`check_host_key` in `sshconnect.c`, lines 1289-1307 of 10.5p1).
_Avoid_: Blocked key, banned key

**Host key policy**:
What the client does with a key that the known hosts do not list, or list with another key. OpenSSH's `StrictHostKeyChecking`: `yes`, `ask`, `accept-new` or `no`. `ssh -G` prints `yes` as `true` and `no` as `false` ([ADR 0005](./docs/adr/0005-host-keys-are-checked-as-gos-knownhosts-checks-them-under-openssh-stricthostkeychecking.md)).
_Avoid_: Trust mode, TOFU (only one of the values)

### Authentication

**Auth method**:
One way to prove the user: `publickey` (RFC 4252 §7), `password` (RFC 4252 §8) or `keyboard-interactive` (RFC 4256). Go's `ssh.AuthMethod`.
_Avoid_: Credential, login type

**Signer**:
Something that holds a private key and signs with it: a parsed private key, or a key of the agent. Go's `ssh.Signer`.
_Avoid_: Key (alone), identity

**Agent**:
A process that holds private keys and signs for its clients over a Unix socket or a named pipe: OpenSSH's `ssh-agent`, 1Password, Secretive. The protocol is draft-ietf-sshm-ssh-agent. Go's `ssh/agent`.
_Avoid_: Keychain, key store

**Agent forwarding**:
Each session asks for it with `auth-agent-req@openssh.com`. The server then opens `auth-agent@openssh.com` channels back to the client, and the client joins each one to a new connection to its agent. When `ClientConfig.agentForwarding` is set, every session asks, as with OpenSSH's `ForwardAgent yes`.
_Avoid_: Agent proxy, SSH_AUTH_SOCK forwarding

**Identity file**:
A file of a private key that the user's config names (`IdentityFile`). OpenSSH's word.
_Avoid_: Key file, private key path

### OpenSSH config

**Resolved config**:
The settings of OpenSSH for one destination, as `ssh -G` prints them after it reads every `Host`, `Match` and `Include` block of the config and the flags. An `OpenSshConfig` holds them ([ADR 0004](./docs/adr/0004-openssh-resolves-the-config-through-ssh-g.md)).
_Avoid_: Parsed config (no parser reads the file), ssh config (the file)

**Route**:
How `OpenSshConfig#dial` reaches the host of a resolved config: `direct` to the hostname and port, `jump` through the jump hosts of `ProxyJump` (only the first has a route of its own), or `proxy-command` over the pipes of a ProxyCommand. OpenSSH allows one of the three. Ours, not an OpenSSH word: OpenSSH names only the two settings.
_Avoid_: Proxy (OpenSSH's settings use it for two of the three kinds), path, transport (the byte stream under the protocol)

**Flags**:
Command-line arguments of `ssh` that the caller gives to `ssh -G`, such as `-o ServerAliveInterval=10`. OpenSSH uses the first value it gets for an option, so a flag wins over the config file. The Docker CLI's word (`sshFlags`).
_Avoid_: Options, SSH options, arguments

**Environment**:
The variables that the host program gives, such as `process.env`. `ssh -G` runs with them. The package reads these variables from them: `SSH_AUTH_SOCK`, `HOME`, `SHELL`, and the variables that `SendEnv` names. The package reads no `process.env` ([ADR 0008](./docs/adr/0008-the-environment-and-the-clock-are-inputs.md)).
_Avoid_: Env, process environment

### The server

**Server conn**:
The server side of one SSH connection after its handshake. Go's `ssh.ServerConn`.
_Avoid_: Connection, peer, client (the other side)

**Server config**:
What a server conn needs for its handshake: the host keys and the auth callbacks. It has no clock: the server waits on no timer of its own. Go's `ssh.ServerConfig`.
_Avoid_: Server options

**Incoming channel**:
A channel that the client asks the server to open: a session, a `direct-tcpip` stream or a `direct-streamlocal@openssh.com` stream. The server accepts or rejects it. Go's `ssh.NewChannel`.
_Avoid_: Channel request (RFC 4254 uses "request" for messages on an open channel)
