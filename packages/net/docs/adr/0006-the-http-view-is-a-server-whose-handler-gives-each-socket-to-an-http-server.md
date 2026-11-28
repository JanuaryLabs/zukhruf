# The HTTP view is a server whose handler gives each socket to an http.Server

Status: Accepted 2026-11-28 (backlog #6078). Ezz approved the paper of 028f631b as written.

Decision-makers: Ezz, on 2026-11-28. The record says: "./http HttpServer is a Server whose handler emits each socket into an http.Server (Node's emit('connection'); close uses the native closeAllConnections)". The probe below shows that the native `closeAllConnections` does nothing for such sockets. The zukhruf session of backlog #6078 proposes what takes its place. The call of each importer changes ("Open for the review" in the README).

`HttpServer` of `@zukhruf/testing/http` is today `new HttpServer().start(handler)`. It gives `{ origin, server, cleanup, [Symbol.asyncDispose] }`. It listens on `127.0.0.1:0`, keeps each accepted socket, and at its disposal closes the `http.Server`, calls `closeAllConnections()`, and waits until a client socket of this process has closed each connection that the close destroyed ([testing ADR 0030](../../../testing/docs/adr/0030-an-http-servers-disposal-waits-until-a-client-of-the-process-has-closed-each-connection-that-the-server-closed.md), with its amendment of #5542). docker's `fakeEngine` does the same on a Unix socket, and it must also destroy the upgraded sockets of an attach, because "An upgraded connection is no longer a connection of the HTTP server" (`fake-engine.ts`).

Of the 106 files that import `HttpServer` (2026-11-28), 104 read `origin`, 19 call `cleanup`, 2 use `server` (elt `web-source.test.ts:563-566`, to close and listen again on the same port), 1 imports `HttpServerHandle`, and 4 import `HttpHandler`.

## The leaders

| Leader     | HTTP over a listener                                                                                                                                                                                 | Its address for a client                                                                                                                                          | Hijacked connections at the close                                                                                                                                |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go         | `http.Server.Serve(l net.Listener)`                                                                                                                                                                  | httptest `Server.URL`: "the base URL of the server, of the form http://address:port with no trailing slash" ([docs](https://pkg.go.dev/net/http/httptest#Server)) | "Close does not attempt to close (and does not even know about) any hijacked connections, such as WebSockets" ([docs](https://pkg.go.dev/net/http#Server.Close)) |
| Node.js 26 | `httpServer.emit('connection', socket)`: "This event can also be explicitly emitted by users to inject connections into the HTTP server" ([docs](https://nodejs.org/api/http.html#event-connection)) | none                                                                                                                                                              | `closeAllConnections()` "does _not_ destroy sockets upgraded to a different protocol" ([docs](https://nodejs.org/api/http.html#servercloseallconnections))       |

## Decision

1. `new HttpServer(handler, options)` makes a `Server` whose handler gives each accepted socket to its own `http.Server` with `emit('connection', socket)`. `handler` is a request listener of `node:http`, as today (testing ADR 0004). `options` are the options of `http.createServer`, and `upgrade`, a listener of the `upgrade` event.
2. `httpServer.serve(endpoint)` gives an `HttpServing`: a `Serving` with, for a TCP endpoint, `origin` (`http://127.0.0.1:<port>`, as httptest's `URL`). A serving on a pipe has no `origin`, because a pipe has no URL; the type gives it only for an endpoint whose address is a `net.SocketAddress`.
3. The close of an HTTP serving is the close of its `Serving` ([ADR 0005](./0005-close-ends-each-accepted-socket-and-waits-for-its-close-and-shutdown-waits-for-the-sockets-until-its-signal-aborts.md)): the serving destroys each socket that it accepted, also an upgraded one. It does not call `closeAllConnections()`.
4. The close then waits as testing ADR 0030 decides: it destroys each client socket of this process that it pairs with a connection that the close destroyed, and waits for the first `close` of each pair. This wait stays in the HTTP view, because it is for the timers of `fetch` (undici), which only HTTP clients have.
5. `shutdown(signal)` of an HTTP serving ends each idle connection at once, and ends each other connection after its response, as Go's `Shutdown` does. At the abort it destroys the rest. The view keeps the state of each socket itself (a request in flight or idle), as Go keeps `ConnState`, because the list of Node.js has no state for an injected socket.
6. `HttpServer`, `HttpHandler` and `HttpServing` are the exports of `@zukhruf/net/http`. `HttpServerHandle`, `cleanup` and the `server` field go.

## Considered Options

- **Keep `new HttpServer().start(handler)` and change only the import.** That was the shape of the record of 2026-11-27 ("change one import, no alias"). The composable shape of 2026-11-28 is the later ruling. `start` would be a second way to do `serve(new TcpEndpoint())`, and `HttpServer` would not be a `Server`.
- **`closeAllConnections()` of the inner `http.Server`, as the record says.** Node.js makes its list of connections in `setupConnectionsTracking`, which runs at the `listening` event of the `http.Server` ([`_http_server.js`](https://github.com/nodejs/node/blob/v26.13.1/lib/_http_server.js)). An `http.Server` that only gets sockets by `emit('connection')` never listens, so `closeAllConnections()` and `closeIdleConnections()` return at `if (!this[kConnections]) return;`. Probe of 2026-11-28 (Node 26.13.1): after a `fetch` through an injected socket, the socket was still open 30 ms after each call. A call to `emit('listening')` on the inner server makes the list, but it is an event that did not happen.
- **Give the `http.Server` to the caller, as `server` today.** One caller uses it, to listen again on the same port. A serving of the same `HttpServer` on `new TcpEndpoint({ port })` does it ([ADR 0004](./0004-a-server-is-a-value-and-serve-gives-a-serving-that-owns-each-socket-that-it-accepted.md)).
- **A Server whose handler gives each socket to an `http.Server`, with the close of the `Serving`.** This option was selected.

## Consequences

- Each of the 106 importing files changes its import and its call: `await new HttpServer().start(handler)` becomes `await new HttpServer(handler).serve(new TcpEndpoint())`. `await handle.cleanup()` becomes `await serving.close()`. The move waits for the release of the package.
- Testing ADRs 0028, 0030 and the amendment of #5542 move to this package as decisions of the HTTP view. Testing ADR 0004 (the handler is a Node request listener) stays true for the view.
- docker's `fakeEngine` becomes an `HttpServer` with `upgrade`, `keepAliveTimeout: 0` and `highWaterMark`, served on a `PipeEndpoint`. Its own count of open connections and its wait for their close are open ("Open for the review").
- testing's `EngineProxy` (HTTP over a Unix socket with an intercept) moves later, after the view works on a pipe.

## Confirmation

- Probe of 2026-11-28 (Node 26.13.1): a `fetch` through a socket that a `net.Server` gives to an `http.Server` with `emit('connection')` gets status 200. `closeIdleConnections()` and `closeAllConnections()` leave the socket open; after `emit('listening')`, `closeAllConnections()` ends it.
- `http.createServer({ keepAliveTimeout: 0, highWaterMark: 1 })` sets both (probe of 2026-11-28).
- The counts of the importers: `grep` over the 106 files of `~/.claude/plans/test-primitives-6078/httpserver-importers.txt` (2026-11-28).
