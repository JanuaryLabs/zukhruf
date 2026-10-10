# A connection closes only when its framing breaks

Lock messages go between processes and threads on a connection: a socket, an IPC channel, or a worker port. A connection carries the messages, and it does not read them ([ADR 0007](./0007-the-connection-is-separate-from-the-lock-requests.md)). Two classes read them. `LockCoordinator` reads the requests, and `RemoteLockClient` reads the answers. Before, each connection also checked each message. Commit de2bbed changed type assertions into checks. The socket connection then closed for a JSON line that failed the check, because it already closed for a line that is not JSON. The IPC channels and the worker ports did not close. They dropped the message. Thus one message got two different results.

A closed connection has a cost. The coordinator releases each key of the process on the other side. That process connects again and reasserts its keys, but a leader after its grace window refuses them, and the process loses them ([ADR 0016](./0016-a-leader-lists-the-requests-that-it-added.md) shows the same problem). On an IPC channel or a worker port, a close is also incorrect. `close()` there removes the listeners of this side, but it does not emit `close`. The coordinator does not end the session, and it keeps the keys of a process that it does not hear. The lock store of a child or a worker does not know that it hears nothing.

Thus a connection closes only when its framing breaks. On a socket, the framing is one JSON line for each message. A line that is not JSON shows that the stream is broken, so no later line is safe to read, and the connection closes. A connection gives each JSON value to its listener without a check. An IPC channel or a worker port gives each lock message in its envelope to its listener. It drops only the messages of the application, which have no envelope. `LockCoordinator` ignores a message that has no `op` or no `id`: an answer must have the `id` of its request, so it cannot answer. It answers a request with an `op` that it does not know with `unsupported`, as before (ADR 0016). `RemoteLockClient` ignores a message that is not an answer that it knows.

## Considered Options

- **Close the connection for each message that cannot be read.** This was the behavior of the socket connection from de2bbed until now. One incorrect line from a process of another version removes all keys of the process. On IPC channels and worker ports, the close is not reported.
- **Answer an error for a message without an `id`.** The other side cannot match that error to a request. JSON-RPC answers with `"id": null` for this case, and its client can only log the error.
- **Each connection checks the messages with its own check.** This was the behavior before. Three connections and two classes each checked the same fields. The connection then must know the lock protocol, which ADR 0007 keeps out of it. The ESLint rule `island/no-generic-port` gives the same rule: a port gives `unknown`, and each consumer checks it.

## Consequences

- A socket line that is JSON but not a lock message is ignored. The connection stays open, and the process keeps its keys. The test "a peer that sends a JSON line that is not a request keeps its key" shows this.
- A socket line that is not JSON still closes the connection.
- `Connection<Outgoing>` emits `unknown`. A new reader of lock messages must check each message before it reads it.
- A leader of an earlier version still closes the connection for such a line. A process of this version never sends one.
