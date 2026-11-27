# Net

A server of this program that accepts connections on a TCP port or a pipe, from the listen to the end of the last connection. The package owns which connections a server accepted, and how they end. What to do with each connection comes from the caller.

## Language

**Endpoint**:
Where a server listens: a TCP host and port (`TcpEndpoint`), or a pipe (`PipeEndpoint` of `@zukhruf/pipes`). An endpoint listens and gives a listener. The word is .NET's `EndPoint`.
_Avoid_: Address (for where to listen), bind target

**Listener**:
What accepts connections on an endpoint, and gives each one to a handler. Its close stops the accepts and leaves each accepted connection open, as Go's `net.Listener` does.
_Avoid_: Server (for the listener alone), socket

**Address**:
Where a client connects to a listener: a `net.SocketAddress` (an IP address and a port) for TCP, a `PipeAddress` for a pipe. Go's `Addr()`.
_Avoid_: Port (for the whole address), origin (for a raw address)

**Handler**:
The function that gets each accepted socket. For HTTP, the request listener of `node:http`.
_Avoid_: Callback, listener (for the function)

**Server**:
A value that says what to do with each connection: a handler and its options. A server listens on nothing until it serves.
_Avoid_: Listener, Serving (for the server while it listens)

**Serving**:
A server while it listens on one endpoint. It keeps each socket that it accepted, from the accept to its close, and it ends them at its close or its shutdown. Our own term: no leader has a type for a server while it listens.
_Avoid_: Handle, instance, running server

**Accepted socket**:
A socket that a listener accepted for a serving. Only the serving ends it.
_Avoid_: Client (for the server's side of a connection), peer

**Close**:
The forced end of a serving: it stops the accepts, destroys each accepted socket, and waits for its `close`. Go's `http.Server.Close`, Kestrel's abort.
_Avoid_: Stop, dispose (for the act; `[Symbol.asyncDispose]` is a close)

**Shutdown**:
The graceful end of a serving: it stops the accepts and waits until each accepted socket has closed by itself, and at the abort of its signal it closes the rest. Go's `Shutdown(ctx)`, Kestrel's `CloseAllConnectionsAsync` then `AbortAllConnectionsAsync`.
_Avoid_: Drain, graceful close

**Origin**:
The URL of an HTTP serving on TCP, `http://<host>:<port>`, with no trailing slash, as httptest's `Server.URL`. A serving on a pipe has none.
_Avoid_: Base URL, host (for the whole origin)

**HTTP view**:
`HttpServer`: a server whose handler gives each accepted socket to its own `http.Server` of Node.js.
_Avoid_: HTTP server (for Node's `http.Server`, which the view holds)
