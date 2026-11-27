# A server is a value, and serve gives a serving that owns each socket that it accepted

Status: Proposed 2026-11-28 (backlog #6078).

Decision-makers: Ezz, on 2026-11-28. The record says: "the composable shape, no statics (the step 2 draft copied httptest.NewServer and Toxiproxy as statics Server.listen / Proxy.to; Go has no constructors, TS does): ... class Server is a value (handler, options) whose serve(endpoint) returns a Serving (address: net.SocketAddress, close(): ends each tracked socket and awaits its close, shutdown(signal), asyncDispose), as Command#start returns a Process". The type of `address` follows [ADR 0003](./0003-an-endpoint-listens-and-gives-a-listener-that-never-ends-an-accepted-socket.md).

The precedent is in this repository. [process ADR 0010](../../../process/docs/adr/0010-a-command-says-what-to-run-and-run-and-start-are-its-methods.md) split what to run from the act: a `Command` is a value, and `command.start()` gives a `Process`. Ezz asked then: "Why everything is a static method? ... I don't want you just to be copying other code blindly." The same split holds here. A server says what to do with each connection. A serving is that server while it listens on one endpoint.

## The leaders

| Leader      | The value                                         | The act                                                                        | What the act gives                                        |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------- |
| Go          | `http.Server{Handler: h}`                         | `srv.Serve(l net.Listener)` ([docs](https://pkg.go.dev/net/http#Server.Serve)) | nothing: `Serve` blocks; `srv` is also the running server |
| Go httptest | none: `httptest.NewServer(handler)`               | the call starts it                                                             | `*httptest.Server`                                        |
| .NET        | `ConnectionHandler` (a handler of one connection) | `KestrelServer.StartAsync`                                                     | the server, which runs                                    |
| Node.js     | `net.createServer(listener)`                      | `server.listen(...)`                                                           | the same `net.Server`                                     |
| zukhruf     | `Command`                                         | `command.start()`                                                              | a `Process`                                               |

Go's `http.Server` is both the value and the running server, and one `Server` serves many listeners. In TypeScript a class can give a second object from a method, as `Command#start` gives a `Process`. Thus the running state has its own type, and a `Server` holds no state of a listen.

## Decision

1. `new Server(handler, options)` holds what to do with each connection, and listens on nothing. `handler` gets each accepted `net.Socket`, as the `connectionListener` of `net.createServer` does.
2. `server.serve(endpoint)` listens on the endpoint and resolves with a `Serving` when it listens. A server can serve more than once, also on two endpoints at once, as Go's `Server.Serve` can serve two listeners.
3. A `Serving` keeps each socket that it accepted, from the accept to its `close` event. It has `address`, `close()`, `shutdown(signal)` and `[Symbol.asyncDispose]()` ([ADR 0005](./0005-close-ends-each-accepted-socket-and-waits-for-its-close-and-shutdown-waits-for-the-sockets-until-its-signal-aborts.md)).
4. `Serving` is an interface. Only `serve()` makes one, through a class that the package does not export, as only `start()` makes a `Process`.
5. The term "serving" is our own: no leader has a type for a server while it listens. It is in [CONTEXT.md](../../CONTEXT.md).

## Considered Options

- **Statics `Server.listen(handler)` and `Server.listen(endpoint, handler)`, after `httptest.NewServer`.** Go has them because Go has no constructors. Ezz refused them.
- **One class that is the value and the running server, as Go's `http.Server`.** Its fields of a listen (the address, the sockets) are then empty before the listen and after the close. A state with empty fields is the state that the user's rule "Make illegal states unrepresentable" removes.
- **A function `serve(endpoint, handler)`.** A caller that serves the same handler again, as elt's `web-source.test.ts` does when its site comes back after a drop, repeats the handler or writes a closure.
- **A server value and a serving.** This option was selected.

## Consequences

- A test that stops a site and starts it again on the same port writes `await serving.close()` and then `server.serve(new TcpEndpoint({ port }))`. Today elt's `web-source.test.ts:563-566` calls `close()` and `listen()` on the `server` of an `HttpServer` handle.
- A call is one step longer than `httptest.NewServer`: `await new Server(handler).serve(new TcpEndpoint())`.
