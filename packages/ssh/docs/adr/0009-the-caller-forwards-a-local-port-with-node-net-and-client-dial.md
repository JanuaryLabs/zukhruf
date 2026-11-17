# The caller forwards a local port with node:net and client.dial

A local forward (`ssh -L`) listens on a local port and joins each connection to a stream that the server dials. `@zukhruf/testing` does this today for a database container on an SSH engine (`forward()` in `packages/testing/src/docker/host.ts`):

- It runs `ssh -L <socket>:127.0.0.1:<port> <host> 'cat >/dev/null'` with stdin as a pipe, a Unix socket in a private folder under `/tmp`, and a local TCP server that joins each client to that socket.
- The remote `cat` is a lifeline: when the test process dies, the pipe closes, `cat` reads EOF, and `ssh` exits (commit `adbf3330`, 2026-10-16, after an `ssh -N` stayed as an orphan under PID 1).
- The run records the forward folder and the `ssh` process. Its close ends stdin and kills `ssh` after 1 s ([testing ADR 0006](../../../testing/docs/adr/0006-a-killed-run-is-cleaned-by-nodes-global-setup-and-teardown.md)). Recovery removes the forward folders of a dead run ([testing ADR 0020](../../../testing/docs/adr/0020-a-reaper-container-removes-a-runs-engine-objects-when-the-attach-that-holds-it-closes-and-recovery-keeps-the-local-records.md), item 6; `packages/testing/src/scripts/run-cleanup.ts`).

The lifeline ends `ssh` only when no forwarded channel is half-open (backlog #4503, "ROOT CAUSE"). That is true for a database, which closes on EOF, and false for a hijacked stream.

What the leaders do (research `~/.claude/plans/zukhruf-ssh-4503-research.md`, "Boundary"):

- **Go** and **Rust** have no forwarder. The caller listens with `net.Listen` and calls `client.Dial` for each connection, or opens `channel_open_direct_tcpip` in russh.
- **.NET** SSH.NET has `ForwardedPortLocal`, a class that owns a local listener.

## Decision

Ezz accepted this decision on 2026-11-17, together with [ADR 0006](./0006-a-jump-host-is-a-connection-through-a-channel-of-the-previous-connection.md) (backlog #4503): "Accept both (Recommended)".

The package has no forwarder class. The caller listens with `node:net` and calls `client.dial('tcp', address)` for each connection:

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

const server = createServer({ allowHalfOpen: true }, (socket) => {
  void carry(socket);
});
server.listen(0, '127.0.0.1');
```

## Considered Options

- **A forwarder class, as .NET's `ForwardedPortLocal`.** It wraps a `net.Server` and a dial, and adds its own close and its own errors. `node:net` already gives the listener, and the caller already owns its life.
- **The OpenSSH child with the remote-cat lifeline.** It is a helper process ([ADR 0002](./0002-the-connection-runs-in-the-node-process-and-no-helper-process-carries-it.md)).
- **No forwarder, as Go and Rust.** This option was selected.

## Consequences

- `@zukhruf/testing` drops the `ssh` child, the Unix socket and its folder, the process record and the 1 s kill. A forward is a `net.Server` and a client. The test process's death closes both, and the server closes each dialed channel.
- The forward records and their recovery go: `forward-*` records in `run-cleanup.ts`, item 6 of testing ADR 0020 for forwards, and the forward part of testing ADR 0006. Each change is an ADR of `@zukhruf/testing`.
- A local forward to a socket on the remote host is the same program with `client.dial('unix', path)`.
