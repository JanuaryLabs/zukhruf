# An HTTP server's disposal waits until a client of the process has closed each connection that the server closed

Status: Proposed 2026-11-24 for the owner's review (backlog #5449).

`HttpServer`'s disposal closes the server and each of its connections. It resolved when the server closed. On Node 26.13, `fetch` keeps the connection open after the response. When the server destroys its side, the client socket emits `close` some turns later. undici clears the timer of the socket in its `close` listener, with the global `clearTimeout` ([ADR 0028](./0028-an-interceptions-disposal-waits-until-the-client-has-closed-each-connection-that-the-server-closed.md) has the path). Thus in a test that fakes the timers with `t.mock.timers`, that `clearTimeout` ran under the fake timers of the next test, and Node removed one of that test's timers. A test that starts a server, fakes `setTimeout`, fetches once, moves its time by 1 s and yields 5 turns, followed by a test that sets a 1 ms timer, yields 5 turns and moves its time by 1 ms: the timer did not fire in 3 of 3 runs. With an msw passthrough for the origin of the server in front, the same test failed in 3 of 3 runs.

On a passthrough, each connection has two client sockets in the process, measured with `@mswjs/interceptors` 0.45.12 and two keep-alive connections. One is the socket of `fetch`, which the interceptor controls. The other is the real socket that the interceptor opens (`lib/node/net-D5G58O2w.js:1078`, `passthrough()`) and whose handle it gives to the first one (`#swapRealHandle`, `:813`). Before the close, both have the local port of the connection. After the close, the socket of `fetch` emits `close`. The real socket emits `end` and becomes destroyed, but it never emits `close`. A disposal that waits for the `close` of each socket of a connection never settles, as in #5485.

A client of `http.request` with an `http.Agent({ keepAlive: true })` did not lose a timer before this change, in 3 of 3 runs. Node's HTTP client does not use the global timers.

## Decision

The disposal waits, for each connection that the close destroyed, until the first client socket of the process that belongs to that connection emits `close`. While the server listens, the server records each connection that it accepts, and records each client socket of the process from Node's `net.client.socket` diagnostics channel. Before the close, the disposal pairs each open connection with the client sockets that are not destroyed and whose remote address and port are the server's, and whose local port is the remote port of the connection. A connection with no client socket in the process, such as a client in a child process, gets no wait.

## Considered Options

- **Wait for the `close` of each paired client socket.** The real socket of a passthrough never emits `close`, so the disposal does not settle.
- **Wait for the `close` of each client socket that the close destroyed, as the msw disposal does.** The close destroys only the server's side. Each client socket is still open when the server has closed, so the disposal waits for none.
- **Destroy the client sockets in the disposal.** The sockets belong to the client of the test, and a request in flight would fail. Their `close` also comes on a later turn.
- **Close undici's global dispatcher.** Node gives it only through the private `Symbol.for('undici.globalDispatcher.1')`.
- **Wait a fixed number of turns.** The number is a guess, and a slower close breaks it again.

## Consequences

- `cleanup()` and the disposal settle a few turns later than before, after the client has seen each close.
- This is the second copy of the socket-close tracking of the msw area. [Code copied into this package](../copied-code.md) records it, and backlog #5498 extracts it when a third place needs it.
- Node caches the local address of a socket at the first read. When code reads `localPort` of the socket of `fetch` before the interceptor gives it the real handle, the socket keeps no local port, and only the real socket pairs with the connection. The disposal then does not settle. Neither undici nor msw reads it then.
- A test of another file that runs at the same time, in the same process, and that connects to this server, is a client of the process too. The disposal also waits for its `close`.
