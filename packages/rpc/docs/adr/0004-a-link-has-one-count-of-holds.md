# A link has one count of holds

Status: Accepted 2026-11-27 (backlog #4984).

Decision-makers: the zukhruf session mutex-91, with Ezz's go "follow the leaders" (step 1b of #4984).

A worker thread ran a `Server` and a `Client` over one `ParentPortConnection`. After the client's last call, the thread stopped listening on its port (its `message` listeners went to 0), and the host's next call got no answer within its 1.5 s timeout while a timer kept the thread alive (`TimeoutError`), or failed with `ConnectionLostError` when the thread exited. `Connection.ref()` and `unref()` are a switch, not a count, and each `Client` kept a private `RefCount` of the link. So the client's last release switched off a ref that the server needed. The tests "a worker thread with a Server and a Client on one link answers the host's next call after the client's last call" and its child-process form in `src/call/server.test.ts` reproduce the bug: each fails with `ConnectionLostError` when the server takes no hold or the link counts nothing.

## Decision

The `ConnectionSupervisor` owns the one `RefCount` (`@zukhruf/async`) of its link. `link.hold()` gives a `Disposable` and replaces `ref()` and `unref()`. The link is ref'd while a hold is out, and the supervisor gives that state to each connection that replaces a lost one. A supervisor that nobody holds lets the process exit.

- `Server.serve(link)` takes the supervisor, not a connection. It opens the link, reads the link's `message` event, answers with `link.send` (an answer that does not reach the link is dropped, because its caller is gone), and holds the link for as long as the link lasts. A closed or unavailable link has no connection left to ref.
- `new PendingCalls(link)` takes no count: each call holds the link from its add until it is taken.
- `Client` takes the hold of each call and of each notification that waits for a connection from the link.

The leaders keep a process alive the same way:

- Node's `net.Server` keeps the process alive from `listen` until `close`, and `server.unref()` lets the process exit (`lib/net.js` `Server.prototype.ref` and `unref`; `doc/api/net.md` `server.unref()`).
- Node's `MessagePort` refs its port while it has at least one `message` listener and unrefs it when the last one goes: a count of listeners, not a switch of one owner (`lib/internal/worker/io.js:228-263`, `setupPortReferencing`).
- StreamJsonRpc's `JsonRpc.StartListening`, vscode-jsonrpc's `connection.listen()` and comlink's `expose` listen on the channel for as long as the channel lasts; a call adds no listener of its own. PGliteWorker serves its worker the same way.
- undici and Node's `http.Agent` with `keepAlive` ref a socket only while a request is in flight on it.

## Considered Options

- **A `RefCount` that every owner of the link shares, given to each `PendingCalls` (step 1).** The mutex gave its two tables one count, but the count lived outside the supervisor. A `Client` and a `Server` on one link had no count to share, which is the bug.
- **The server refs the connection, and the client keeps its private count.** The client's last release still unrefs the connection the server needs.
- **A count in each adapter.** Every adapter would count again what the supervisor already carries across a replacement, and a replacement would start at zero.

## Consequences

Every owner of work on a link takes its holds from the link. A thread or a child process that serves stays alive until its link is closed, and exits by itself then. The mutex's coordinators keep their own `ref` and `unref` of raw sockets: they serve without a supervisor.

## Confirmation

`src/call/server.test.ts`: in a worker thread and in a child process, a server and a client on one link answer the parent's call after the client's last call, and a process that only serves stays alive and exits once it closes its link. `src/connection/connection-supervisor.test.ts`: one of two holds keeps the IPC channel ref'd, and the process exits once nobody holds it. Mutations M1p, M2p, M3p and M4 to M8 were CAUGHT (`mutate.mjs`, 2026-11-27); the thread side is out of reach of a mutation, so the child-process tests carry those claims.
