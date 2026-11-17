# @zukhruf/ssh

> Design on paper: no code exists yet. Ezz accepted each ADR on 2026-11-17 (backlog #4503).

An SSH client and server that run inside the Node process. A client connects to an SSH server, runs commands in sessions, and dials sockets and ports on the remote host. It reads the user's `~/.ssh/config` through `ssh -G`, checks host keys against the known hosts, and signs with the agent. The types follow Go's [`golang.org/x/crypto/ssh`](https://pkg.go.dev/golang.org/x/crypto/ssh) and its subpackages, and the protocol is [ssh2](https://github.com/mscdex/ssh2) ([ADR 0001](./docs/adr/0001-the-scope-and-the-name-of-gos-ssh-package.md), [ADR 0003](./docs/adr/0003-ssh2-speaks-the-protocol.md)).

No helper process carries a connection. The connection is a TCP connection of the Node process. When that process dies, also by `SIGKILL`, the kernel closes the TCP connection, and the SSH server closes each channel and each socket that a channel opened. Nothing is left on either machine. Through an `ssh` child, a dead owner reached the remote side only as EOF, and 203 `ssh … docker system dial-stdio` processes stayed alive on one laptop (backlog #4503, [ADR 0002](./docs/adr/0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md)).

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/ssh
```

```ts
import { OpenSshConfig } from '@zukhruf/ssh/config';

const config = await OpenSshConfig.resolve('mac-mini', {
  environment: process.env,
});
await using client = await config.dial({ clock: globalThis });
const uname = await client.newSession().output('uname -sr');
console.log(String(uname).trim());
```

The package has four import paths, after Go's subpackages:

| Import path               | What it has                                                                  | Go                                                                                           |
| ------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `@zukhruf/ssh`            | `Client`, `ClientConfig`, `Session`, `RemoteListener`, keys, `ServerConn`    | `ssh`                                                                                        |
| `@zukhruf/ssh/agent`      | `AgentClient`, a client of an agent on a socket that the caller connected    | `ssh/agent`                                                                                  |
| `@zukhruf/ssh/knownhosts` | `KnownHosts`, `KeyError`, `RevokedError`                                     | `ssh/knownhosts`                                                                             |
| `@zukhruf/ssh/config`     | `OpenSshConfig`: the settings of OpenSSH for a destination, through `ssh -G` | none; tools do it ([ADR 0004](./docs/adr/0004-openssh-resolves-the-config-through-ssh-g.md)) |

Only `@zukhruf/ssh/config` needs the `ssh` binary.

## Connect with the settings of OpenSSH

`OpenSshConfig.resolve(destination, options)` runs `ssh -G <flags> -- <destination>`. OpenSSH reads every `Host`, `Match` and `Include` block, and prints the settings. The package makes no connection in this step ([ADR 0004](./docs/adr/0004-openssh-resolves-the-config-through-ssh-g.md)).

```ts
import { OpenSshConfig } from '@zukhruf/ssh/config';

const config = await OpenSshConfig.resolve('ssh://root@box:2222', {
  flags: ['-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2'],
  environment: process.env,
});
console.log(config.hostname, config.port, config.user, config.route.kind);

await using client = await config.dial({
  clock: globalThis,
  signal: AbortSignal.timeout(60_000),
});
```

- The destination is OpenSSH's: `[user@]hostname[:port]`, an `ssh://` URI, or a `Host` name of the config.
- The flags are raw flags of `ssh`. They come first, so a flag wins over the config file, as in OpenSSH.
- `environment` is required. `ssh -G` runs with it. The package reads these variables from it: `SSH_AUTH_SOCK`, `HOME`, `SHELL`, and the variables that `SendEnv` names. The package reads no `process.env` ([ADR 0008](./docs/adr/0008-the-environment-and-the-clock-are-inputs.md)).

`config.dial()` connects as OpenSSH would:

1. It follows `config.route`: `direct` goes straight to `hostname:port`, `jump` goes through each jump host of `ProxyJump` ([ADR 0006](./docs/adr/0006-a-jump-host-is-a-connection-through-a-channel-of-the-previous-connection.md)), and `proxy-command` goes over the pipes of a `ProxyCommand` ([ADR 0010](./docs/adr/0010-a-proxycommand-runs-as-the-transport-of-the-connection.md)).
2. It checks the host key against `UserKnownHostsFile` and `GlobalKnownHostsFile`, under `StrictHostKeyChecking` ([Check the host key](#check-the-host-key)).
3. It authenticates with the agent, then with the identity files. It never prompts: no password, no passphrase, no host key question.
4. It applies `ConnectTimeout` and `ServerAliveInterval` only when the config or the flags set them ([ADR 0007](./docs/adr/0007-keepalive-and-timeouts-come-only-from-the-resolved-config.md)).
5. It puts each `SetEnv` variable, and each variable of the environment that a `SendEnv` pattern names, in `ClientConfig.sessionEnv`. Each session sends them first ([Open a terminal](#open-a-terminal)).

## Connect with a config that you build

`Client.dial(address, config)` is Go's `ssh.Dial`. It needs no `ssh` binary and reads no file. The caller gives each input.

```ts
import { connect } from 'node:net';

import { Client } from '@zukhruf/ssh';
import { AgentClient } from '@zukhruf/ssh/agent';
import { KnownHosts } from '@zukhruf/ssh/knownhosts';

await using socket = connect(process.env.SSH_AUTH_SOCK!);
const agent = new AgentClient(socket);
const knownHosts = await KnownHosts.read([
  `${process.env.HOME}/.ssh/known_hosts`,
]);

await using client = await Client.dial('box.example.com:22', {
  user: 'deploy',
  auth: [{ type: 'publickey', signers: () => agent.signers() }],
  hostKey: (hostname, port, key) => knownHosts.check(hostname, port, key),
  hostKeyAlgorithms: knownHosts.hostKeyAlgorithms('box.example.com', 22),
  clock: globalThis,
});
```

`hostKey` is required, as Go's `HostKeyCallback` is. The package has no default that trusts a key. `clock` is required too ([root ADR 0004](../../docs/adr/0004-a-library-that-waits-takes-the-clock-as-an-input.md)): give `globalThis` in production, and `createClock()` of `@sinonjs/fake-timers` in a test.

## Run a command

A session runs one command. `run()` waits for the exit status, `output()` also gives stdout, and `combinedOutput()` gives stdout and stderr together. These are Go's `Run`, `Output` and `CombinedOutput`.

```ts
import { ExitError } from '@zukhruf/ssh';

await client.newSession().run('test -d /srv/app');

const listing = await client
  .newSession()
  .output('ls /srv/app')
  .catch((error) => {
    if (
      error instanceof ExitError &&
      error.exit.kind === 'status' &&
      error.exit.exitStatus === 2
    )
      return undefined;
    throw error;
  });
```

A non-zero exit status rejects with `ExitError` whose `exit` is `{ kind: 'status', exitStatus }`. A command that a signal ended rejects with `ExitError` whose `exit` is `{ kind: 'signal', signal, coreDumped, errorMessage }`. The signal is a name of RFC 4254 §6.10, or a name with an `@`: sshd sends `SIG@openssh.com` for each other signal (`sig2name` in OpenSSH's `session.c`, lines 2265-2283 of 10.5p1). A session whose channel closes with no exit status rejects with `ExitMissingError`: the connection or the server ended the command, and the outcome is not known.

A close of the session does not end its command. sshd closes only the pipes of a command without a pty (`session_close_by_channel` in OpenSSH's `session.c`; backlog #4503). To end a command, send it a signal, or run it with a pty, whose close is a hangup.

## Stream the input and the output of a command

`start(command)` opens the channel and returns when the server accepted the command. `stdin`, `stdout` and `stderr` are Node streams. They exist from `newSession()`, and data flows after `start()`. The end of `stdin` sends `SSH_MSG_CHANNEL_EOF`, so the command reads the end of its input, and the output stays open.

```ts
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

await using session = client.newSession();
await session.start('docker exec -i db psql -U postgres');
await pipeline(createReadStream('seed.sql'), session.stdin);
await session.wait();
```

`wait()` resolves at exit status 0. It rejects with `ExitError` or `ExitMissingError`, as `run()` does. Output that nothing reads is discarded once `wait()` or `close()` runs, as Go discards the output of a nil `Stdout`: the server sends the channel's close only after its data is read. `close()` resolves when `SSH_MSG_CHANNEL_CLOSE` is sent, as Go's `Close` does, and does not wait for the server's answer, which sshd sends only after the command ends.

## Open a terminal

`setenv` and `requestPty` record a request, and `ClientConfig.agentForwarding` adds `auth-agent-req@openssh.com` to each session. `start()` or `shell()` sends the requests before the command. ssh2 sends them in this order (`exec` and `shell` in `client.js:1192-1308`):

1. Each `env`: first the variables of `ClientConfig.sessionEnv`, then the variables of `setenv`.
2. `auth-agent-req@openssh.com`.
3. `pty-req`.
4. `exec` or `shell`.

This order is not the order of OpenSSH. OpenSSH sends `auth-agent-req@openssh.com`, then `pty-req`, then each `env`, then `exec` or `shell` (`ssh_session2_setup` in `ssh.c`, `client_session2_setup` in `clientloop.c`).

The package sends each `env` with no reply wanted, as ssh2 and OpenSSH send it (`reqEnv` in `client.js`, `client_send_env` in `clientloop.c`). So a server that refuses a variable (`AcceptEnv`) ignores it, and `start()` does not fail. Go's `Setenv` is different: it wants a reply, and it returns an error when the server refuses (`ssh/session.go:172-175` of `golang.org/x/crypto` v0.59.0). ssh2 wants a reply to `pty-req` and to `auth-agent-req@openssh.com`, so a refused pty or a refused agent forwarding rejects `start()` or `shell()`. OpenSSH sends `auth-agent-req@openssh.com` with no reply wanted.

```ts
await using session = client.newSession();
session.setenv('LANG', 'en_US.UTF-8');
session.requestPty('xterm-256color', { rows: 40, columns: 120 });
await session.shell();

process.stdin.pipe(session.stdin);
session.stdout.pipe(process.stdout);
process.stdout.on('resize', () =>
  session.windowChange({
    rows: process.stdout.rows,
    columns: process.stdout.columns,
  }),
);
await session.wait();
```

`signal(name)` sends a signal to the command. It takes the names of RFC 4254 §6.10, with no `SIG`: `'INT'`, `'TERM'`, `'KILL'`, `'HUP'`. The server delivers it once the command runs. `start()` resolves when the server accepts the command, which can be before sshd has started it, and sshd drops a signal that finds no process: wait for a sign that the command runs, such as its first output, before you send one.

## Dial a socket on the remote host

`client.dial(network, address)` opens a stream through the server: `'tcp'` to `host:port`, or `'unix'` to the path of a socket on the remote host. It gives a `Duplex`. It is Go's `Client.Dial`. Each call is one channel on the same connection.

```ts
import { request } from 'node:http';

const engine = await client.dial('unix', '/Users/me/.docker/run/docker.sock');
request({ path: '/_ping', createConnection: () => engine }, (response) =>
  console.log(response.statusCode),
).end();

const postgres = await client.dial('tcp', '127.0.0.1:5432');
```

The end of the stream's write side sends channel EOF, as the end of input of a Unix socket. `destroy()` closes the channel.

A server can refuse a dial. Tailscale SSH allows a `'unix'` dial only under the user's home, `/tmp` and `/run/user/<uid>` (`ssh/tailssh/fwdmonitor.go`, `fwdAllowedSocketPath`). OpenSSH's sshd allows it by default (`AllowStreamLocalForwarding yes`). The dial then rejects with the reason that the server sent, such as `administratively prohibited`.

## Forward a local port

The package has no forwarder class, as in Go and Rust ([ADR 0009](./docs/adr/0009-the-caller-forwards-a-local-port-with-node-net-and-client-dial.md)). Listen with `node:net`, and dial for each connection:

```ts
import { type Socket, createServer } from 'node:net';
import { pipeline } from 'node:stream/promises';

async function carry(socket: Socket): Promise<void> {
  const remote = await client
    .dial('tcp', '127.0.0.1:5432')
    .catch(() => undefined);
  if (!remote) return void socket.destroy();
  await Promise.allSettled([
    pipeline(socket, remote),
    pipeline(remote, socket),
  ]);
}

await using server = createServer({ allowHalfOpen: true }, (socket) => {
  void carry(socket);
}).listen(0, '127.0.0.1');
```

## Listen on the remote host

`client.listen(network, address, connectionListener)` asks the server to listen: `tcpip-forward` for `'tcp'`, `streamlocal-forward@openssh.com` for `'unix'`. Each connection to that socket comes to the listener as a `Duplex`. For `'tcp'`, the listener also gets the origin, the address of the peer; a `'unix'` connection has none (`forwarded-streamlocal@openssh.com` carries no origin, OpenSSH `PROTOCOL` §2.4). This is OpenSSH's `ssh -R`, and Go's `Client.Listen`.

```ts
await using listener = await client.listen(
  'tcp',
  '127.0.0.1:0',
  (stream, origin) => {
    stream.end(`hello ${origin}\n`);
  },
);
console.log(listener.address); // 127.0.0.1:<the port that the server chose>
```

The close of the listener sends the cancel request. The close of the client ends every listener.

## Connect through a jump host

`OpenSshConfig#dial` follows a `jump` route by itself: it reaches the first jump host (a `FirstJumpHost`) by that jump host's own route, and each later jump host (a `JumpHost`) through the jump host before it, as OpenSSH does. The root import path gives the step that it uses: `Client.handshake(transport, address, config)` runs the handshake on a stream that the caller gives. It is Go's `NewClientConn` ([ADR 0006](./docs/adr/0006-a-jump-host-is-a-connection-through-a-channel-of-the-previous-connection.md)).

```ts
// jumpConfig and dbConfig are a ClientConfig each.
await using jump = await Client.dial('jump.example.com:22', jumpConfig);
const channel = await jump.dial('tcp', 'db.internal:22');
await using db = await Client.handshake(channel, 'db.internal:22', dbConfig);
```

No process carries the connection to a jump host. When the owner dies, the kernel closes the TCP connection to the first jump host, and each server closes its part of the chain.

## Check the host key

`KnownHosts` checks a key as Go's `knownhosts` does, and matches a line as OpenSSH does where the two differ ([ADR 0005](./docs/adr/0005-host-keys-are-checked-as-gos-knownhosts-checks-them-under-openssh-stricthostkeychecking.md)). It reads plain names, patterns with `*`, `?` and `!`, hashed names (`|1|`), `[host]:port` for a port other than 22, and `@revoked` lines. `hostKeyAlgorithms()` puts the algorithms of the known keys first, as OpenSSH does, so the server signs with a key that the client knows (golang/go#29286).

A host key callback that adds an unknown key and refuses a changed or revoked one is OpenSSH's `accept-new`:

```ts
import type { HostKeyCallback } from '@zukhruf/ssh';
import { KeyError, KnownHosts } from '@zukhruf/ssh/knownhosts';

const knownHosts = await KnownHosts.read([
  `${process.env.HOME}/.ssh/known_hosts`,
]);
const hostKey: HostKeyCallback = async (hostname, port, key) => {
  try {
    knownHosts.check(hostname, port, key);
  } catch (error) {
    if (!(error instanceof KeyError) || error.want.length > 0) throw error;
    await knownHosts.add(hostname, port, key, { hash: true });
  }
};
```

`@zukhruf/ssh/config` applies OpenSSH's `StrictHostKeyChecking`, and never prompts. `ssh -G` prints `true`, `false`, `ask` or `accept-new` (`multistate_strict_hostkey` in OpenSSH's `readconf.c`): it prints `yes` as `true`, and `no` and its other spelling `off` as `false`. `OpenSshConfig#strictHostKeyChecking` gives each value its config name:

| `strictHostKeyChecking` | `ssh -G` prints | Unknown key                                   | Changed key                                      | Revoked key                          |
| ----------------------- | --------------- | --------------------------------------------- | ------------------------------------------------ | ------------------------------------ |
| `'yes'`                 | `true`          | `KeyError`, `want` empty                      | `KeyError`, `want` lists the known keys          | `RevokedError`                       |
| `'ask'` (the default)   | `ask`           | As `'yes'`                                    | As `'yes'`                                       | `RevokedError`                       |
| `'accept-new'`          | `accept-new`    | Adds the key to the first user file; connects | `KeyError`                                       | `RevokedError`                       |
| `'no'`                  | `false`         | Adds the key to the first user file; connects | Connects, with the restrictions of OpenSSH below | Connects, with the same restrictions |

Under `no`, OpenSSH connects to a host whose key changed or is revoked, but it turns off password and keyboard-interactive auth, agent forwarding, X11 forwarding, each `LocalForward` and `RemoteForward` (`-L`, `-R`) and tunnels. It does not turn off `-W`, the stdio forward that `ProxyJump` uses (`check_host_key` in `sshconnect.c` of OpenSSH 10.5p1: a revoked key at lines 1289-1307, the restrictions at lines 1365-1416). The client does the same ([ADR 0005](./docs/adr/0005-host-keys-are-checked-as-gos-knownhosts-checks-them-under-openssh-stricthostkeychecking.md)):

- `client.dial` works, as `-W` does, so a chain of jump hosts goes on.
- `client.listen` rejects with `KeyError`, as OpenSSH cancels `-R`.
- Agent forwarding is off: no session asks for it.
- The client offers no password and no keyboard-interactive auth.

A line is added hashed when `HashKnownHosts` is `yes`. A host that only an `@cert-authority` line trusts fails with `KeyError`: ssh2 offers no certificate host key algorithm ([ADR 0003](./docs/adr/0003-ssh2-speaks-the-protocol.md)).

## Sign with the agent

`AgentClient` speaks the agent protocol over a socket that the caller connected. It is Go's `agent.NewClient`. It lists the keys, signs, adds and removes keys, and locks the agent.

```ts
import { connect } from 'node:net';

import { AgentClient } from '@zukhruf/ssh/agent';

await using socket = connect(process.env.SSH_AUTH_SOCK!);
const agent = new AgentClient(socket);
for (const { key, comment } of await agent.list())
  console.log(key.fingerprint(), comment);
```

Agent forwarding needs a new connection to the agent for each channel that the server opens back, as OpenSSH and Go's `agent.ForwardToRemote` open one. So `ClientConfig.agentForwarding` is a function that connects. When it is set, every session asks for agent forwarding before it starts, as with OpenSSH's `ForwardAgent yes`. Here `config` is a `ClientConfig`, as in [Connect with a config that you build](#connect-with-a-config-that-you-build):

```ts
await using client = await Client.dial('box.example.com:22', {
  ...config,
  agentForwarding: async () => connect(process.env.SSH_AUTH_SOCK!),
});
await client.newSession().run('git clone git@github.com:acme/app.git');
```

`@zukhruf/ssh/config` reads `ForwardAgent` as OpenSSH does ([ADR 0004](./docs/adr/0004-openssh-resolves-the-config-through-ssh-g.md)). It sets `agentForwarding` from `forwardAgent`: for `yes`, a connection to the `SSH_AUTH_SOCK` of the caller's environment; for a socket path, or a `$NAME` of the environment, a connection to that socket; for `no`, nothing. A forwarded agent signs for the remote host, so set `ForwardAgent` only for a host that you trust, as for `ssh`. A `ClientConfig` that the caller builds forwards nothing unless the caller sets `agentForwarding`.

## Bound the start, and find a dead connection

The package has no timeout and no keepalive of its own ([ADR 0007](./docs/adr/0007-keepalive-and-timeouts-come-only-from-the-resolved-config.md)):

- `connectTimeout` is OpenSSH's `ConnectTimeout`. It limits the TCP connect, the banner exchange and the key exchange, on the clock of the config. When it passes, the dial rejects with a `TimeoutError`.
- `keepalive` is OpenSSH's `ServerAliveInterval` and `ServerAliveCountMax`. Without it, a connection to a machine that stops answering hangs a call until its signal aborts, as with OpenSSH.
- `@zukhruf/ssh/config` sets them only from the resolved config, so `~/.ssh/config` and the flags decide.

```ts
// config is a ClientConfig without the two settings.
await using client = await Client.dial('box.example.com:22', {
  ...config,
  connectTimeout: 10_000,
  keepalive: { interval: 10_000, countMax: 2 },
});
await client.wait().catch((error) => console.error('lost', error));
```

`client.wait()` resolves after `close()`, and rejects with the error that ended the connection. It is Go's `Conn.Wait`.

## Run a server

`ServerConn.handshake(transport, config)` runs the server side of a connection on a stream that the caller accepted. It is Go's `NewServerConn` ([ADR 0011](./docs/adr/0011-the-package-has-a-server-as-go-and-rust-do.md)). The package opens no listener: `node:net` does. Ezz decided that the package has a server, and that its API takes Go's shape.

```ts
import { readFile } from 'node:fs/promises';
import { type Socket, createServer } from 'node:net';

import { PrivateKey, PublicKey, ServerConn } from '@zukhruf/ssh';
import type { ServerSession } from '@zukhruf/ssh';

const hostKey = PrivateKey.parse(await readFile('host_ed25519'));
const { key: allowed } = PublicKey.parseAuthorizedKey(
  await readFile('test.pub', 'utf8'),
);

async function serve(session: ServerSession): Promise<void> {
  for await (const request of session.requests()) {
    if (request.type === 'pty-req') {
      request.accept();
    } else if (request.type === 'exec') {
      request.accept();
      session.stdout.end(`ran ${request.command}\n`);
      await session.exit(0);
      return;
    } else if ('reject' in request) {
      request.reject();
    }
  }
}

async function accept(socket: Socket): Promise<void> {
  await using conn = await ServerConn.handshake(socket, {
    hostKeys: [hostKey],
    publicKey: (user, key) => user === 'test' && key.equals(allowed),
  });
  const sessions: Promise<void>[] = [];
  for await (const channel of conn.channels()) {
    if (channel.type !== 'session') {
      channel.reject();
      continue;
    }
    sessions.push(serve(channel.accept()));
  }
  await Promise.allSettled(sessions);
}

createServer((socket) => {
  void accept(socket);
}).listen(2222);
```

## Errors

Each class marks a different next step for the caller.

| Error                    | When                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KeyError`               | `@zukhruf/ssh/knownhosts`. The known hosts have no key for the host (`want` is empty), or only other keys (`want` lists them with file and line), under the policy of [Check the host key](#check-the-host-key). A person adds the key, or reports a possible attack. Go's `knownhosts.KeyError`.                                                                                                                                                       |
| `RevokedError`           | `@zukhruf/ssh/knownhosts`. The host key is on an `@revoked` line. `@zukhruf/ssh/config` throws it under `StrictHostKeyChecking` `yes`, `ask` and `accept-new`; under `no` it connects in the restricted mode of a changed key, as OpenSSH. `revoked` has its file and line. Go's `knownhosts.RevokedError`.                                                                                                                                             |
| `AuthenticationError`    | The server refused every auth method. `attempted` lists the methods tried, and `allowed` the methods that the server still lists. The caller adds a key to the agent or to `authorized_keys`, and does not try again unchanged. SSH.NET's `SshAuthenticationException`; Go has no class.                                                                                                                                                                |
| `PassphraseMissingError` | `PrivateKey.parse` got an encrypted key and no passphrase. `publicKey` is set when the file has it in clear. The caller asks for the passphrase or uses the agent. `@zukhruf/ssh/config` skips such an identity file, as OpenSSH does in batch mode. Go's `PassphraseMissingError`.                                                                                                                                                                     |
| `ExitError`              | `run()`, `output()`, `combinedOutput()` and `wait()`, when the command exited with a status other than 0 (`exit.kind` is `'status'`, with `exitStatus`) or a signal ended it (`exit.kind` is `'signal'`, with `signal`, `coreDumped` and `errorMessage`). Go's `ExitError`.                                                                                                                                                                             |
| `ExitMissingError`       | The same calls, when the channel closed with no `exit-status` and no `exit-signal`. The connection or the server ended the command, and the outcome is not known: do not run a command that is not idempotent again as if it failed. When a lost connection ended the channel, `cause` is the error that ended the connection. An `exit-signal` whose name is neither an RFC 4254 name nor a `name@domain` name also gives it. Go's `ExitMissingError`. |
| The error of Node.js     | Every other failure of a dial, with its `code`: `ENOTFOUND`, `ECONNREFUSED`, `ETIMEDOUT`, `ECONNRESET`. A signal rejects with its reason, an `AbortError` by default. `connectTimeout` rejects with a `DOMException` named `TimeoutError`. The caller treats the host as absent, or tries again later.                                                                                                                                                  |

A failure of the connection has no class of its own. Every error of `Client.dial`, `Client.handshake` or `OpenSshConfig#dial` that is not one of the classes above is a failure to connect, and each of them has the same next step. A handshake failure, such as no shared key exchange algorithm, is an `Error` whose message names it. The package does not give ssh2's `level` field as its API.

A connection that is lost after the start ends each open channel with an error whose `cause` is the error that ended the connection, and `client.wait()` rejects with it. A failed `ssh -G` rejects `OpenSshConfig.resolve` with an `Error` whose message is the standard error of `ssh` and whose `cause` has its exit code.

## What the package does not do

- **No helper process carries a connection.** A ProxyCommand of the user's config is the one process that the package runs for the life of a connection ([ADR 0002](./docs/adr/0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md), [ADR 0010](./docs/adr/0010-a-proxycommand-runs-as-the-transport-of-the-connection.md)). A ProxyCommand that ignores the end of its stdin can outlive its owner, as it can for OpenSSH.
- **It never prompts.** No password, passphrase or host key question. A caller can give a password or a keyboard-interactive callback in `ClientConfig.auth`; `@zukhruf/ssh/config` never adds them.
- **No SFTP.** Go and Rust give it in a separate package (`github.com/pkg/sftp`, russh-sftp). It is a subsystem protocol with its own draft.
- **No forwarder class for `ssh -L` or `ssh -D`.** The caller composes `node:net` and `client.dial` ([ADR 0009](./docs/adr/0009-the-caller-forwards-a-local-port-with-node-net-and-client-dial.md)). A SOCKS server for `-D` is the same composition, as in Go and Rust.
- **No certificates.** ssh2 1.17.0 has no `*-cert-v01@openssh.com` algorithm, so `@cert-authority` host keys and certificate user keys do not work ([ADR 0003](./docs/adr/0003-ssh2-speaks-the-protocol.md)).
- **No post-quantum key exchange.** ssh2's best is `curve25519-sha256`. OpenSSH 10.0 made `mlkem768x25519-sha256` its default ([ADR 0003](./docs/adr/0003-ssh2-speaks-the-protocol.md)).
- **No parser of `ssh_config`.** OpenSSH resolves the config through `ssh -G` ([ADR 0004](./docs/adr/0004-openssh-resolves-the-config-through-ssh-g.md)).
- **No connection sharing (`ControlMaster`).** The master is a process that outlives its clients. A program shares one `Client` by holding it.
- **No `KnownHostsCommand`, `VerifyHostKeyDNS`, `CheckHostIP` or `UpdateHostKeys`.** Without them, the client trusts only the known hosts files: it accepts fewer keys, never more ([ADR 0004](./docs/adr/0004-openssh-resolves-the-config-through-ssh-g.md)).
- **No keepalive and no timeout of its own** ([ADR 0007](./docs/adr/0007-keepalive-and-timeouts-come-only-from-the-resolved-config.md)).
- **No agent server.** Go's `agent.NewKeyring` and `agent.ServeAgent` hold private keys in the program's memory, which an agent such as `ssh-agent`, 1Password or Secretive exists to avoid. The package is a client of such an agent.
- **No X11 forwarding and no GSSAPI.** Node has no display server, and ssh2 has no GSSAPI.

## The same concepts in other systems

| Concept                     | Other systems                                                                                                                                                                                                                                                                                          |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A client and its dial       | Go: `ssh.Dial(network, addr, *ClientConfig)`. Rust russh: `client::connect`. .NET SSH.NET: `SshClient`, `ConnectionInfo`. Podman: `ssh.Dial(*ConnectionDialOptions, mode)` of `containers/common/pkg/ssh`. OpenSSH: `ssh`.                                                                             |
| A handshake on a stream     | Go: `ssh.NewClientConn(conn, addr, config)`. russh: `connect_stream` (`client/mod.rs`). SSH.NET: none.                                                                                                                                                                                                 |
| A session                   | Go: `Session` with `Run`, `Start`, `Wait`, `Output`, `Setenv`, `RequestPty`, `WindowChange`, `Signal`, `Shell` (`session.go:167-357`). russh: `channel_open_session`. SSH.NET: `RunCommand`, `CreateCommand`, `SshCommand`. OpenSSH: `ssh host command`.                                               |
| A dial to a socket or port  | Go: `Client.Dial("unix" \| "tcp", addr)` (`tcpip.go:380-461`). russh: `channel_open_direct_streamlocal`, `channel_open_direct_tcpip`. Podman: `DialNet(client, "unix", url)`. SSH.NET: no streamlocal (#238). OpenSSH: `ssh -W`, `direct-streamlocal@openssh.com` (`PROTOCOL` §2.4).                   |
| A local forward             | Go and russh: none; the caller listens and dials. SSH.NET: `ForwardedPortLocal`. OpenSSH: `ssh -L`.                                                                                                                                                                                                    |
| A remote listener           | Go: `Client.Listen`, `ListenTCP`, `ListenUnix` (`tcpip.go:29`, `:116`, `streamlocal.go:34`). russh: `tcpip_forward`, `streamlocal_forward`. SSH.NET: `ForwardedPortRemote`. OpenSSH: `ssh -R`.                                                                                                         |
| A jump host                 | Go: `NewClientConn` over `Client.Dial`. russh: `connect_stream`. VS Code: an `ssh -J … -W` child (`sshProxyJump.ts:107-114`). SSH.NET: none (#481, #530). OpenSSH: `ProxyJump`, an `ssh -W` child.                                                                                                     |
| Known hosts                 | Go: `ssh/knownhosts` with `KeyError` and `RevokedError`. Podman: skeema/knownhosts, which orders the host key algorithms (golang/go#29286). russh: known_hosts in its keys module. SSH.NET: only the `HostKeyReceived` event. OpenSSH: sshd(8), SSH_KNOWN_HOSTS FILE FORMAT.                           |
| The config through `ssh -G` | VS Code: `execFile('ssh', ['-G', '--', host])` and `parseSSHGOutput` (`sshRemoteAgentHostService.ts:1397`). distant: "Tries ssh -G first". zed, `gh codespace`, coder, the Buildkite agent, trzsz-ssh, nh. Go, russh and SSH.NET: none.                                                                |
| An agent client             | Go: `agent.NewClient(conn)`, `agent.ForwardToRemote`, `agent.RequestAgentForwarding` (`agent/forward.go:19-58`). russh: an agent client in its keys module. SSH.NET: none. OpenSSH: `ssh-add`, `ForwardAgent`.                                                                                         |
| A server                    | Go: `ssh.NewServerConn` (`server.go:356`). russh: its `server` module. SSH.NET: none. OpenSSH: `sshd`.                                                                                                                                                                                                 |
| SSH in the owner's process  | Podman's remote client: one connection in its process, the engine socket dialed for each HTTP connection (`pkg/bindings/connection.go`), `dial-stdio` on a session when the server refuses (`connection_stdio.go`). docker-modem: ssh2 with `dial-stdio` for each request. docker/cli: an `ssh` child. |

## What each call does underneath

The RFC sections are of RFC 4252 (authentication), RFC 4253 (transport) and RFC 4254 (connection). The ssh2 calls are of ssh2 1.17.0.

| Call                                      | On the wire                                                                                                                                                                                                                                                                                              | ssh2                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OpenSshConfig.resolve()`                 | Nothing. `ssh -G <flags> -- <destination>` prints the settings and exits                                                                                                                                                                                                                                 | None                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Client.dial(address, config)`            | A TCP connect, the version exchange, the key exchange (RFC 4253 §7), the authentication (RFC 4252)                                                                                                                                                                                                       | `net.connect`, then `new Client().connect({ sock, username, hostVerifier, algorithms: { serverHostKey }, authHandler, readyTimeout: 0, strictVendor: false })`                                                                                                                                                                                                                                       |
| `Client.handshake(transport, …)`          | The same, on the given stream                                                                                                                                                                                                                                                                            | `connect({ sock: transport, … })`                                                                                                                                                                                                                                                                                                                                                                    |
| `hostKey`                                 | Gets the host key of the key exchange reply                                                                                                                                                                                                                                                              | `hostVerifier(key, verify)`                                                                                                                                                                                                                                                                                                                                                                          |
| auth `publickey`                          | `SSH_MSG_USERAUTH_REQUEST` `publickey`, a query, then a signature (RFC 4252 §7)                                                                                                                                                                                                                          | `authHandler` → `{ type: 'agent', agent }`, with an ssh2 `BaseAgent` that serves the signers                                                                                                                                                                                                                                                                                                         |
| auth `password`, `keyboard-interactive`   | `password` (RFC 4252 §8); `keyboard-interactive` (RFC 4256)                                                                                                                                                                                                                                              | `authHandler` → `{ type: 'password' }`, `{ type: 'keyboard-interactive', prompt }`                                                                                                                                                                                                                                                                                                                   |
| `connectTimeout`                          | Nothing; a timer on the clock until the key exchange ends                                                                                                                                                                                                                                                | Ends at the `handshake` event (`client.js:323`)                                                                                                                                                                                                                                                                                                                                                      |
| `keepalive`                               | `SSH_MSG_GLOBAL_REQUEST` `keepalive@openssh.com`, reply wanted, at each interval, also when data came. The count of requests with no reply resets only on a reply to one, or on a channel success or failure. OpenSSH sends one only after an interval with no data from the server                      | `keepaliveInterval`, `keepaliveCountMax`; the timer and its reset in `client.js:646`, `:656`, `:712-743`                                                                                                                                                                                                                                                                                             |
| `client.dial('tcp', 'host:port')`         | `SSH_MSG_CHANNEL_OPEN` `direct-tcpip` (RFC 4254 §7.2), originator `0.0.0.0` port 0, as Go's `Client.Dial`                                                                                                                                                                                                | `forwardOut('0.0.0.0', 0, host, port)` (`client.js:1398`)                                                                                                                                                                                                                                                                                                                                            |
| `client.dial('unix', path)`               | `SSH_MSG_CHANNEL_OPEN` `direct-streamlocal@openssh.com` (OpenSSH `PROTOCOL` §2.4)                                                                                                                                                                                                                        | `openssh_forwardOutStreamLocal(path)` (`client.js:1533`)                                                                                                                                                                                                                                                                                                                                             |
| `client.listen('tcp', …)`                 | `tcpip-forward` (RFC 4254 §7.1); each connection is a `forwarded-tcpip` channel                                                                                                                                                                                                                          | `forwardIn(host, port)` (`client.js:1333`), event `tcp connection`                                                                                                                                                                                                                                                                                                                                   |
| `client.listen('unix', …)`                | `streamlocal-forward@openssh.com`; each connection is a `forwarded-streamlocal@openssh.com` channel                                                                                                                                                                                                      | `openssh_forwardInStreamLocal(path)` (`client.js:1457`), event `unix connection`                                                                                                                                                                                                                                                                                                                     |
| `listener.close()`                        | `cancel-tcpip-forward`, `cancel-streamlocal-forward@openssh.com`                                                                                                                                                                                                                                         | `unforwardIn`, `openssh_unforwardInStreamLocal`                                                                                                                                                                                                                                                                                                                                                      |
| `session.start(command)`                  | A `session` channel (RFC 4254 §6.1), then each `env` (§6.4, no reply wanted), `auth-agent-req@openssh.com` when `agentForwarding` is set (reply wanted), `pty-req` (§6.2, reply wanted), `exec` (§6.5). OpenSSH sends `auth-agent-req@openssh.com` (no reply wanted), `pty-req`, each `env`, then `exec` | `exec(command, { env, pty })` (`client.js:1192-1247`)                                                                                                                                                                                                                                                                                                                                                |
| `session.shell()`                         | The same, with `shell` (§6.5)                                                                                                                                                                                                                                                                            | `shell(window, { env })` (`client.js:1249-1308`), with `window` `false` when no pty was asked for: ssh2 asks for a pty otherwise (`client.js:1290-1291`)                                                                                                                                                                                                                                             |
| `sessionEnv`                              | Each `env` (§6.4), no reply wanted, as the first requests of each session, before the variables of `setenv`                                                                                                                                                                                              | The `env` object of `exec` and `shell`; `reqEnv` sends it at once with no reply wanted (`client.js:1863-1891`)                                                                                                                                                                                                                                                                                       |
| `session.stdin.end()`, a stream's `end()` | `SSH_MSG_CHANNEL_EOF` (RFC 4254 §5.3)                                                                                                                                                                                                                                                                    | `channel.end()`                                                                                                                                                                                                                                                                                                                                                                                      |
| `session.stderr`                          | `SSH_MSG_CHANNEL_EXTENDED_DATA`, type 1 (§5.2)                                                                                                                                                                                                                                                           | `channel.stderr`                                                                                                                                                                                                                                                                                                                                                                                     |
| `session.windowChange()`                  | `window-change` (§6.7)                                                                                                                                                                                                                                                                                   | `channel.setWindow(rows, columns, height, width)` (`Channel.js:221`)                                                                                                                                                                                                                                                                                                                                 |
| `session.signal()`                        | `signal` (§6.9)                                                                                                                                                                                                                                                                                          | `channel.signal(name)` (`Channel.js:237`)                                                                                                                                                                                                                                                                                                                                                            |
| `session.wait()`                          | `exit-status` or `exit-signal` (§6.10), then `SSH_MSG_CHANNEL_CLOSE`                                                                                                                                                                                                                                     | the `exit` event, then the `close` event of the channel                                                                                                                                                                                                                                                                                                                                              |
| `session.close()`, a stream's `destroy()` | `SSH_MSG_CHANNEL_CLOSE` (§5.3)                                                                                                                                                                                                                                                                           | `channel.close()` (`Channel.js:207`)                                                                                                                                                                                                                                                                                                                                                                 |
| `agentForwarding`                         | Each session sends `auth-agent-req@openssh.com` before its command, as OpenSSH's `ForwardAgent yes`. The server opens `auth-agent@openssh.com` channels; each one is joined to a new connection to the agent                                                                                             | `agent` with `getStream`, and `agentForward: true`, given to `connect` (`client.js:219-226`, `:1995-2006`). With them, ssh2 sends `auth-agent-req@openssh.com` on `exec` and `shell` (`config.allowAgentFwd`, `client.js:1221-1226`, `:1283-1288`), but only on the first session of a client (`_agentFwdEnabled`, `client.js:1801-1806`). Build item: the package sends the request on each session |
| `client.close()`                          | `SSH_MSG_DISCONNECT`, then the transport closes                                                                                                                                                                                                                                                          | `end()` (`client.js:1179`)                                                                                                                                                                                                                                                                                                                                                                           |
| The owner process dies                    | Nothing more: the kernel closes the TCP connection, and the server closes each channel                                                                                                                                                                                                                   | None                                                                                                                                                                                                                                                                                                                                                                                                 |
| `AgentClient`                             | The agent protocol over the caller's socket (draft-ietf-sshm-ssh-agent)                                                                                                                                                                                                                                  | `list` and `sign` through ssh2's `AgentProtocol` (`agent.js:509`); `add`, `remove` and `lock` in the package                                                                                                                                                                                                                                                                                         |
| `KnownHosts`                              | Nothing                                                                                                                                                                                                                                                                                                  | None                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ServerConn.handshake()`                  | The server side of RFC 4253 and RFC 4252                                                                                                                                                                                                                                                                 | `new Server({ hostKeys }).injectSocket(transport)` (`server.js:217`, `:361`)                                                                                                                                                                                                                                                                                                                         |
| `serverConn.forward()`                    | `SSH_MSG_CHANNEL_OPEN` `forwarded-tcpip` or `forwarded-streamlocal@openssh.com`                                                                                                                                                                                                                          | `forwardOut`, `openssh_forwardOutStreamLocal` of the server's client (`server.js:1295`, `:1301`)                                                                                                                                                                                                                                                                                                     |

## API

```ts
// @zukhruf/ssh

import type { Duplex, Readable, Writable } from 'node:stream';

import type { Clock } from '@zukhruf/async';

/** One SSH connection and its channels. Go's ssh.Client. */
export class Client implements AsyncDisposable {
  /** Opens a TCP connection to `address` (host:port) with node:net, and runs the handshake on it. Go's ssh.Dial. */
  static dial(
    address: string,
    config: ClientConfig,
    options?: { readonly family?: 4 | 6; readonly signal?: AbortSignal },
  ): Promise<Client>;
  /** Runs the handshake on a stream that the caller opened: a channel of a jump host, the pipes of a ProxyCommand. Go's ssh.NewClientConn with ssh.NewClient. */
  static handshake(
    transport: Duplex,
    address: string,
    config: ClientConfig,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Client>;
  readonly user: string;
  /** The version line of the server, such as SSH-2.0-OpenSSH_10.3. Go's ServerVersion. */
  readonly serverVersion: string;
  /** 'tcp': a direct-tcpip channel to host:port. 'unix': a direct-streamlocal@openssh.com channel to a socket path. Go's Client.Dial. */
  dial(
    network: 'tcp' | 'unix',
    address: string,
    options?: { readonly signal?: AbortSignal },
  ): Promise<Duplex>;
  /** tcpip-forward. Each connection comes to connectionListener with its origin, host:port of the peer. Go's Client.Listen. */
  listen(
    network: 'tcp',
    address: string,
    connectionListener: (stream: Duplex, origin: string) => void,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RemoteListener>;
  /** streamlocal-forward@openssh.com. A forwarded-streamlocal@openssh.com channel carries no origin. Go's Client.ListenUnix. */
  listen(
    network: 'unix',
    path: string,
    connectionListener: (stream: Duplex) => void,
    options?: { readonly signal?: AbortSignal },
  ): Promise<RemoteListener>;
  /** A session. Its channel opens at start(), run(), output(), combinedOutput() or shell(). Go's Client.NewSession. */
  newSession(): Session;
  /** Resolves after close(). Rejects with the error that ended the connection. Go's Conn.Wait. */
  wait(): Promise<void>;
  /** Sends SSH_MSG_DISCONNECT and closes the transport, then the clients of its jump hosts. It sends SIGHUP to its ProxyCommand and does not wait for it, as OpenSSH. A later call waits for the same close. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** Go's ssh.ClientConfig. */
export interface ClientConfig {
  readonly user: string;
  /** Tried in order. Go's ClientConfig.Auth. */
  readonly auth: readonly AuthMethod[];
  /** Throws to refuse the key. Required: no default trusts a key. Go's HostKeyCallback. */
  readonly hostKey: HostKeyCallback;
  /** The host key algorithms to offer, in order. Default: each one that the package supports. Go's HostKeyAlgorithms. */
  readonly hostKeyAlgorithms?: readonly string[];
  readonly clock: Clock;
  /** OpenSSH's ConnectTimeout, in ms: the TCP connect, the banner exchange and the key exchange. Default: no limit. */
  readonly connectTimeout?: number;
  /** OpenSSH's ServerAliveInterval (ms) and ServerAliveCountMax. Default: no keepalive. */
  readonly keepalive?: {
    readonly interval: number;
    readonly countMax: number;
  };
  /** When set, every session asks for agent forwarding (auth-agent-req@openssh.com) before its command, as OpenSSH's ForwardAgent yes, and each auth-agent@openssh.com channel gets a new connection from this function. In the root import path, because ssh2 takes the agent and agentForward when it connects. Go's agent.ForwardToRemote with agent.RequestAgentForwarding. */
  readonly agentForwarding?: () => Promise<Duplex>;
  /** The env requests that each new session sends before its first other request, with no reply wanted. OpenSshConfig#dial fills it from SetEnv, and from the variables of the caller's environment that SendEnv names. OpenSSH's SetEnv and SendEnv. */
  readonly sessionEnv?: Readonly<Record<string, string>>;
}

export type HostKeyCallback = (
  hostname: string,
  port: number,
  key: PublicKey,
) => void | Promise<void>;

/** Go's ssh.AuthMethod: PublicKeysCallback, Password, KeyboardInteractive. */
export type AuthMethod =
  | {
      readonly type: 'publickey';
      readonly signers: () => Promise<readonly Signer[]>;
    }
  | { readonly type: 'password'; readonly password: string }
  | {
      readonly type: 'keyboard-interactive';
      readonly respond: (
        prompts: readonly Prompt[],
      ) => Promise<readonly string[]>;
    };

/** RFC 4256 §3.2. */
export interface Prompt {
  readonly prompt: string;
  readonly echo: boolean;
}

/** A private key that signs: a parsed key, or a key of the agent. Go's ssh.Signer. */
export interface Signer {
  readonly publicKey: PublicKey;
  sign(data: Uint8Array, algorithm?: string): Promise<Uint8Array>;
}

/** Go's ssh.PublicKey. */
export class PublicKey {
  /** The wire form, RFC 4253 §6.6. Go's ParsePublicKey. */
  static parse(wire: Uint8Array): PublicKey;
  /** A line of authorized_keys or of a .pub file. Go's ParseAuthorizedKey. */
  static parseAuthorizedKey(line: string): {
    readonly key: PublicKey;
    readonly comment: string;
    readonly options: readonly string[];
  };
  /** Such as ssh-ed25519. */
  readonly type: string;
  /** Go's Marshal. */
  readonly wire: Uint8Array;
  /** SHA256:<base64>, as ssh-keygen -l prints it. Go's FingerprintSHA256. */
  fingerprint(): string;
  equals(other: PublicKey): boolean;
  /** <type> <base64>, as a line of authorized_keys. Go's MarshalAuthorizedKey. */
  toString(): string;
}

/** Go's ParsePrivateKey and ParsePrivateKeyWithPassphrase. */
export class PrivateKey implements Signer {
  /** An OpenSSH key, or a PKCS#1, PKCS#8 or SEC1 PEM key. Throws PassphraseMissingError for an encrypted key with no passphrase. */
  static parse(data: Uint8Array, passphrase?: string): PrivateKey;
  readonly publicKey: PublicKey;
  sign(data: Uint8Array, algorithm?: string): Promise<Uint8Array>;
}

/** One command or shell on the remote host. Go's ssh.Session. */
export class Session implements AsyncDisposable {
  /** Its end sends SSH_MSG_CHANNEL_EOF. */
  readonly stdin: Writable;
  readonly stdout: Readable;
  /** SSH_MSG_CHANNEL_EXTENDED_DATA, type 1. */
  readonly stderr: Readable;
  /** An env request, sent at start after the variables of ClientConfig.sessionEnv, with no reply wanted, as ssh2 and OpenSSH send it: a server that refuses the variable ignores it. Go's Setenv wants a reply and returns an error on a refusal. */
  setenv(name: string, value: string): void;
  /** Sent at start. A refusal rejects start() or shell(). Go's RequestPty. */
  requestPty(term: string, size: WindowSize, modes?: TerminalModes): void;
  /** Resolves when the server accepted the command. Go's Start. */
  start(command: string): Promise<void>;
  /** A login shell. Go's Shell. */
  shell(): Promise<void>;
  /** Resolves at exit status 0. Rejects with ExitError or ExitMissingError. Go's Wait. */
  wait(): Promise<void>;
  /** start(), then wait(). Go's Run. */
  run(command: string): Promise<void>;
  /** run(), and stdout. Go's Output. */
  output(command: string): Promise<Buffer>;
  /** run(), and stdout and stderr in the order they came. Go's CombinedOutput. */
  combinedOutput(command: string): Promise<Buffer>;
  /** Go's WindowChange. */
  windowChange(size: WindowSize): Promise<void>;
  /** Go's Signal. */
  signal(name: SignalName): Promise<void>;
  /** SSH_MSG_CHANNEL_CLOSE. sshd does not end a command without a pty on a close. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface WindowSize {
  readonly rows: number;
  readonly columns: number;
  readonly width?: number;
  readonly height?: number;
}

/** The terminal modes of RFC 4254 §8 by name, such as { ECHO: 0, ISIG: 1 }. */
export type TerminalModes = Readonly<Record<string, number>>;

/** RFC 4254 §6.10, with no SIG. */
export type SignalName =
  | 'ABRT'
  | 'ALRM'
  | 'FPE'
  | 'HUP'
  | 'ILL'
  | 'INT'
  | 'KILL'
  | 'PIPE'
  | 'QUIT'
  | 'SEGV'
  | 'TERM'
  | 'USR1'
  | 'USR2';

/** A socket that the server listens on for the client. */
export class RemoteListener implements AsyncDisposable {
  readonly network: 'tcp' | 'unix';
  /** For port 0, the port that the server chose. */
  readonly address: string;
  /** cancel-tcpip-forward or cancel-streamlocal-forward@openssh.com. */
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

/** How the command of a session ended: exit-status or exit-signal, RFC 4254 §6.10. */
export type Exit =
  | { readonly kind: 'status'; readonly exitStatus: number }
  | {
      readonly kind: 'signal';
      /** sshd sends SIG@openssh.com for a signal outside RFC 4254's list (session.c, sig2name). */
      readonly signal: SignalName | `${string}@${string}`;
      readonly coreDumped: boolean;
      readonly errorMessage: string;
    };

/** Go's ExitError. */
export class ExitError extends Error {
  readonly exit: Exit;
}

export class ExitMissingError extends Error {}

export class AuthenticationError extends Error {
  readonly attempted: readonly string[];
  readonly allowed: readonly string[];
}

export class PassphraseMissingError extends Error {
  readonly publicKey: PublicKey | undefined;
}

/** Go's ssh.ServerConfig. No clock: the server waits on no timer, and the signal of ServerConn.handshake bounds a slow handshake. */
export interface ServerConfig {
  readonly hostKeys: readonly PrivateKey[];
  /** Go's PublicKeyCallback. */
  readonly publicKey?: (
    user: string,
    key: PublicKey,
  ) => boolean | Promise<boolean>;
  /** Go's PasswordCallback. */
  readonly password?: (
    user: string,
    password: string,
  ) => boolean | Promise<boolean>;
  /** Go's KeyboardInteractiveCallback. */
  readonly keyboardInteractive?: (
    user: string,
    ask: (prompts: readonly Prompt[]) => Promise<readonly string[]>,
  ) => boolean | Promise<boolean>;
}

/** The server side of one connection, after its handshake. Go's ssh.ServerConn. */
export class ServerConn implements AsyncDisposable {
  /** Go's ssh.NewServerConn. */
  static handshake(
    transport: Duplex,
    config: ServerConfig,
    options?: { readonly signal?: AbortSignal },
  ): Promise<ServerConn>;
  readonly user: string;
  readonly clientVersion: string;
  /** Go's <-chan NewChannel. */
  channels(): AsyncIterable<IncomingChannel>;
  /** Go's <-chan *Request, for the global requests. */
  requests(): AsyncIterable<GlobalRequest>;
  /** forwarded-tcpip, for a tcpip-forward that the server accepted: address is the listened address, origin host:port of the peer. */
  forward(network: 'tcp', address: string, origin: string): Promise<Duplex>;
  /** forwarded-streamlocal@openssh.com, for a streamlocal-forward that the server accepted. It carries no origin. */
  forward(network: 'unix', path: string): Promise<Duplex>;
  close(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}

export type IncomingChannel =
  | { readonly type: 'session'; accept(): ServerSession; reject(): void }
  | {
      readonly type: 'direct-tcpip';
      readonly address: string;
      readonly origin: string;
      accept(): Duplex;
      reject(): void;
    }
  | {
      readonly type: 'direct-streamlocal@openssh.com';
      readonly path: string;
      accept(): Duplex;
      reject(): void;
    };

export type GlobalRequest =
  | {
      readonly type: 'tcpip-forward';
      readonly address: string;
      /** port: the port that the server bound, when the address asked for port 0 (RFC 4254 §7.1). */
      accept(port?: number): void;
      reject(): void;
    }
  | {
      readonly type: 'cancel-tcpip-forward';
      readonly address: string;
      accept(): void;
      reject(): void;
    }
  | {
      readonly type:
        | 'streamlocal-forward@openssh.com'
        | 'cancel-streamlocal-forward@openssh.com';
      readonly path: string;
      accept(): void;
      reject(): void;
    };

/** A session channel that the server accepted. */
export class ServerSession {
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly stderr: Writable;
  requests(): AsyncIterable<SessionRequest>;
  /** Sends exit-status, or exit-signal, and closes the channel. */
  exit(
    status:
      | number
      | {
          readonly signal: SignalName | `${string}@${string}`;
          readonly coreDumped?: boolean;
          readonly errorMessage?: string;
        },
  ): Promise<void>;
}

export type SessionRequest =
  | {
      readonly type: 'env';
      readonly name: string;
      readonly value: string;
      accept(): void;
      reject(): void;
    }
  | {
      readonly type: 'pty-req';
      readonly term: string;
      readonly size: WindowSize;
      readonly modes: TerminalModes;
      accept(): void;
      reject(): void;
    }
  | { readonly type: 'window-change'; readonly size: WindowSize }
  | {
      readonly type: 'signal';
      readonly name: SignalName | `${string}@${string}`;
    }
  | {
      readonly type: 'exec';
      readonly command: string;
      accept(): void;
      reject(): void;
    }
  | {
      readonly type: 'shell' | 'auth-agent-req@openssh.com';
      accept(): void;
      reject(): void;
    };

// @zukhruf/ssh/agent

import type { Duplex } from 'node:stream';

import type { PrivateKey, PublicKey, Signer } from '@zukhruf/ssh';

/** A client of an agent over a socket that the caller connected. Go's agent.NewClient. draft-ietf-sshm-ssh-agent. */
export class AgentClient {
  constructor(socket: Duplex);
  list(): Promise<AgentKey[]>;
  /** One signer for each key; each signature is a request to the agent. Go's Signers. */
  signers(): Promise<Signer[]>;
  sign(
    key: PublicKey,
    data: Uint8Array,
    options?: { readonly algorithm?: 'rsa-sha2-256' | 'rsa-sha2-512' },
  ): Promise<Uint8Array>;
  /** lifetime in ms, as ssh-add -t; confirm, as ssh-add -c. */
  add(
    key: PrivateKey,
    options?: {
      readonly comment?: string;
      readonly lifetime?: number;
      readonly confirm?: boolean;
    },
  ): Promise<void>;
  remove(key: PublicKey): Promise<void>;
  removeAll(): Promise<void>;
  lock(passphrase: string): Promise<void>;
  unlock(passphrase: string): Promise<void>;
}

export interface AgentKey {
  readonly key: PublicKey;
  readonly comment: string;
}

// @zukhruf/ssh/knownhosts

import type { PublicKey } from '@zukhruf/ssh';

/** The keys of the known hosts files. Go's ssh/knownhosts. */
export class KnownHosts {
  /** Reads the files in order; a missing file is empty. Go's knownhosts.New. */
  static read(files: readonly string[]): Promise<KnownHosts>;
  /** Throws KeyError or RevokedError. Looks up [hostname]:port when the port is not 22. */
  check(hostname: string, port: number, key: PublicKey): void;
  /** The algorithms of the known keys of the host first, then the rest of `offered`. Default `offered`: each one that the package supports. */
  hostKeyAlgorithms(
    hostname: string,
    port: number,
    offered?: readonly string[],
  ): string[];
  /** Appends a line to the first file, hashed when `hash` is true. Go's knownhosts.Line. */
  add(
    hostname: string,
    port: number,
    key: PublicKey,
    options: { readonly hash: boolean },
  ): Promise<void>;
}

/** Go's knownhosts.KnownKey. */
export interface KnownKey {
  readonly key: PublicKey;
  readonly file: string;
  readonly line: number;
}

/** Go's knownhosts.KeyError: an empty `want` means an unknown host. */
export class KeyError extends Error {
  readonly want: readonly KnownKey[];
}

/** Go's knownhosts.RevokedError. */
export class RevokedError extends Error {
  readonly revoked: KnownKey;
}

// @zukhruf/ssh/config

import type { Clock } from '@zukhruf/async';
import type { Client } from '@zukhruf/ssh';

export type Environment = Readonly<Record<string, string | undefined>>;

/** The settings of OpenSSH for one destination, as ssh -G prints them. */
export class OpenSshConfig {
  /** Runs ssh -G <flags> -- <destination> with `environment`, and resolves each jump host of the route with its own ssh -G. */
  static resolve(
    destination: string,
    options: {
      readonly flags?: readonly string[];
      readonly environment: Environment;
      readonly signal?: AbortSignal;
    },
  ): Promise<OpenSshConfig>;
  readonly destination: string;
  readonly hostname: string;
  readonly port: number;
  readonly user: string;
  readonly hostKeyAlias: string | undefined;
  readonly knownHostsFiles: {
    readonly user: readonly string[];
    readonly global: readonly string[];
  };
  /** ssh -G prints true, false, ask or accept-new: 'yes', 'no', 'ask', 'accept-new'. */
  readonly strictHostKeyChecking: 'yes' | 'ask' | 'accept-new' | 'no';
  readonly hashKnownHosts: boolean;
  /** Without the algorithms that ssh2 does not have. */
  readonly hostKeyAlgorithms: readonly string[];
  /** The agent socket; undefined for IdentityAgent none, or no SSH_AUTH_SOCK. */
  readonly identityAgent: string | undefined;
  /** With ~ expanded from HOME of the environment. */
  readonly identityFiles: readonly string[];
  readonly identitiesOnly: boolean;
  readonly route: Route;
  /** ms; undefined for none. */
  readonly connectTimeout: number | undefined;
  /** undefined when ServerAliveInterval is 0. */
  readonly keepalive:
    { readonly interval: number; readonly countMax: number } | undefined;
  /** undefined for any. */
  readonly addressFamily: 4 | 6 | undefined;
  readonly setEnv: ReadonlyMap<string, string>;
  readonly sendEnv: readonly string[];
  /** ForwardAgent as OpenSSH resolves it: no, yes (the agent at SSH_AUTH_SOCK of the environment), or a socket path (a $NAME value is read from the environment). dial sets ClientConfig.agentForwarding from it. */
  readonly forwardAgent:
    | { readonly kind: 'off' }
    | { readonly kind: 'agent' }
    | { readonly kind: 'socket'; readonly path: string };
  /** Connects by the route, checks the host key under the policy, authenticates with the agent, then the identity files, and sets sessionEnv from setEnv and sendEnv, and agentForwarding from forwardAgent. */
  dial(options: {
    readonly clock: Clock;
    readonly signal?: AbortSignal;
  }): Promise<Client>;
}

/** How dial reaches the host. OpenSSH uses one of the three: ProxyJump and ProxyCommand exclude each other. */
export type Route =
  | { readonly kind: 'direct' }
  /** ProxyCommand, with its tokens not yet expanded (ADR 0010). */
  | { readonly kind: 'proxy-command'; readonly command: string }
  /** ProxyJump, in the order of the list. Only the first jump host has a route of its own (ADR 0006). */
  | {
      readonly kind: 'jump';
      readonly jumpHosts: readonly [FirstJumpHost, ...JumpHost[]];
    };

/** The resolved settings of a jump host, by its own ssh -G, with no route: OpenSSH reaches a jump host after the first through the one before it, and reads no ProxyJump or ProxyCommand of its config. A jump host opens no session, so it has no session env and no agent forwarding. */
export type JumpHost = Omit<
  OpenSshConfig,
  'route' | 'setEnv' | 'sendEnv' | 'forwardAgent' | 'dial'
>;

/** The first jump host: the one jump host that follows its own ProxyJump or ProxyCommand. */
export interface FirstJumpHost extends JumpHost {
  readonly route: Route;
}
```

## Why not an npm package

The package depends on ssh2 for the protocol, and adds the rest: the known hosts, `ssh -G`, the agent and identity files from the config, jump hosts, the `AbortSignal` of each call, the clock, and the API of Go ([ADR 0003](./docs/adr/0003-ssh2-speaks-the-protocol.md)). The search of npm on 2026-11-17 found no package that gives that rest:

| Package                      | Last release | Downloads a week | Packages | Why it is not the package                                                                                                          |
| ---------------------------- | ------------ | ---------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ssh2` 1.17.0                | 2025-08-20   | 21.2M            | 8        | The protocol base. No known_hosts, no config, no `AbortSignal`, no certificate host keys; `privateKey` takes bytes. One maintainer |
| `node-ssh` 14.0.0            | 2026-11-16   | 467k             | 12       | Wraps ssh2 and adds nothing that this package needs                                                                                |
| `ssh2-promise` 1.0.3         | 2022-06-19   | 23k              | 14       | No streamlocal; stale                                                                                                              |
| `tunnel-ssh` 5.2.0           | 2024-12-15   | 406k             | 9        | A port-forward helper                                                                                                              |
| `@microsoft/dev-tunnels-ssh` | 2026-08-24   | 46k              | 13       | Its own stack; no agent client, no streamlocal message                                                                             |
| `ssh-config` 5.3.0           | 2026-09-11   | 234k             | 1        | A parser: no `Include`, `Match exec` behind an option, no defaults, no `%h` or `%p`. `ssh -G` needs no package                     |
| `sshpk` 1.18.0               | 2023-10-19   | 21.8M            | 10       | Parses keys and certificates; no known_hosts parser; stale                                                                         |
| `known_hosts` 1.0.3          | 2016-03-31   | 10               | 0        | Only `\|1\|` entries, no markers; dead                                                                                             |

ssh2's footprint is 8 packages. Its optional native parts, `sshcrypto.node` and `cpu-features`, stay unbuilt. zukhruf's `.npmrc` sets `strict-allow-scripts=true`, so an install fails when a dependency has an install script that `allowScripts` does not name. The root `allowScripts` does not list `ssh2` and `cpu-features` yet: the first code commit adds `"ssh2": false` and `"cpu-features": false`. ssh2 falls back to JavaScript when they are missing (`protocol/crypto.js:30-33`, `protocol/constants.js:5-8`). A test run measures that fallback before the first release, which answers the Electron concern of [docker ADR 0001](../docker/docs/adr/0001-the-client-speaks-the-engine-api-not-the-docker-cli.md).

## What each repository changes

The package leads. Each repository below changes to fit it, with no adapter, and no consumer shapes the API ([ADR 0001](./docs/adr/0001-the-scope-and-the-name-of-gos-ssh-package.md)).

| Repository and file                                            | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Backlog          |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `@zukhruf/docker`: `src/transport.ts`, `src/ssh-connection.ts` | `SocketTransport` and `SshTransport` become one HTTP transport over a dial function, as moby's `WithDialContext` takes docker/cli's `helper.Dialer` (`client/client_options.go`, `cli/context/docker/load.go`). `unix://` and `npipe://` dial through `node:net`. `ssh://` resolves an `OpenSshConfig` with `sshFlags` (and `-o ConnectTimeout=30` when they do not name it, as the Docker CLI), holds one `Client`, and dials `client.dial('unix', <engine socket>)` for each HTTP connection. Docker finds the engine socket itself: a session runs `docker context inspect --format '{{.Endpoints.docker.Host}}'` on the remote host. When the server refuses the dial, docker refuses with a clear error that names the server's refusal and the fixes: rootless Docker, whose socket is under `/run/user/<uid>`, or an OpenSSH server. It has no `docker system dial-stdio` fallback (Ezz, 2026-11-17: "Refuse with a clear error"); Podman's `connection_stdio.go` fallback was the precedent that lost. `SshExitError` goes; the errors of this package become the `cause` of `ConnectionFailedError`. New ADRs supersede the connection helper of docker ADR 0002 and all of ADR 0010. | #4503            |
| `@zukhruf/docker`: `src/testing/ssh-stand-in.ts`               | The fake `ssh` binary of the attach, disposal, local-engine and ssh-engine tests gives way to a real server: `ServerConn` of this package in the test process, or an sshd container                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | #4503            |
| `@zukhruf/docker`: `README.md`, `CONTEXT.md`                   | Line 5 and the `package.json` description ("no third-party dependencies"), the `ssh` rows of the errors, and the section "SSH engines". The terms "Connection helper" and "Connection failure"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | #4503            |
| `@zukhruf/testing`: `src/docker/host.ts`                       | `shell()` becomes `client.newSession().output(script)`, with the input on `stdin`. `forward()` becomes a `node:net` server and `client.dial('tcp', '127.0.0.1:<port>')` ([ADR 0009](./docs/adr/0009-the-caller-forwards-a-local-port-with-node-net-and-client-dial.md)). `sshArgs()`, the remote `cat`, the forward folder, its record and the 1 s kill go. Tests: `src/docker/ssh-forward.integration.test.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | #4503            |
| `@zukhruf/testing`: `src/scripts/run-cleanup.ts`               | The `forward-*` records go. `execFileSync('ssh', …)` for `rm -rf` is synchronous, because the global teardown must finish under `--test-force-exit`: it becomes a session in a worker that the teardown waits for with `Atomics.wait` (docker ADR 0001), or stays a one-shot `ssh`. Testing decides in its own ADR                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | #4503            |
| text2sql: `infra/dokploy/seed/box.ts`                          | `ssh()` becomes `output()`. `streamToBox()` becomes `session.start(remoteCommand)` with the local command's stdout piped to `session.stdin`. `SSH_OPTS` become the flags of `OpenSshConfig.resolve`; `StrictHostKeyChecking=accept-new` keeps its meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | #4513 (text2sql) |

## Documentation

**Decisions**

- [ADR 0001](./docs/adr/0001-the-scope-and-the-name-of-gos-ssh-package.md): the scope and the name of Go's ssh package.
- [ADR 0002](./docs/adr/0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md): the connection runs in the Node process, and no helper process carries it.
- [ADR 0003](./docs/adr/0003-ssh2-speaks-the-protocol.md): ssh2 speaks the protocol.
- [ADR 0004](./docs/adr/0004-openssh-resolves-the-config-through-ssh-g.md): OpenSSH resolves the config through ssh -G.
- [ADR 0005](./docs/adr/0005-host-keys-are-checked-as-gos-knownhosts-checks-them-under-openssh-stricthostkeychecking.md): host keys are checked as Go's knownhosts checks them, under OpenSSH's StrictHostKeyChecking.
- [ADR 0006](./docs/adr/0006-a-jump-host-is-a-connection-through-a-channel-of-the-previous-connection.md): a jump host is a connection through a channel of the previous connection.
- [ADR 0007](./docs/adr/0007-keepalive-and-timeouts-come-only-from-the-resolved-config.md): keepalive and timeouts come only from the resolved config.
- [ADR 0008](./docs/adr/0008-the-environment-and-the-clock-are-inputs.md): the environment and the clock are inputs.
- [ADR 0009](./docs/adr/0009-the-caller-forwards-a-local-port-with-node-net-and-client-dial.md): the caller forwards a local port with node:net and client.dial.
- [ADR 0010](./docs/adr/0010-a-proxycommand-runs-as-the-transport-of-the-connection.md): a ProxyCommand runs as the transport of the connection.
- [ADR 0011](./docs/adr/0011-the-package-has-a-server-as-go-and-rust-do.md): the package has a server, as Go and Rust do.
