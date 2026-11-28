# An endpoint listens and gives a listener that never ends an accepted socket

Status: Accepted 2026-11-28 (backlog #6078). Ezz approved the paper of 028f631b as written.

Decision-makers: Ezz, on 2026-11-28, for the shape. The record says: "interface Endpoint { listen(handler): Promise<Listener> } (PipeEndpoint of @zukhruf/pipes already has it; new TcpEndpoint({ host = 127.0.0.1, port = 0 }) over net.Server.listen), Listener never ends accepted sockets (Go net.Listener)". The zukhruf session of backlog #6078 proposes the type of the address and the `address` of `PipeServer` below; both are in the "Open for the review" list of the README.

A server must listen on a TCP port of the loopback address in most tests, and on a Unix socket or a Windows named pipe in mutex, single-flight, election and docker. The server does the same work in each case: it keeps each accepted socket, and it ends each one at its close. Thus where it listens is an input of the server, not a second kind of server.

## The leaders

| Leader           | Where to listen                                                                                                                                                | What listens                                                                                                                                                                                 | Its address                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| .NET             | `EndPoint`: `IPEndPoint`, `DnsEndPoint`, `UnixDomainSocketEndPoint` ([docs](https://learn.microsoft.com/dotnet/api/system.net.endpoint))                       | `IConnectionListenerFactory.BindAsync(EndPoint)` gives an `IConnectionListener` ([docs](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.connections.iconnectionlistenerfactory)) | `IConnectionListener.EndPoint` |
| Go               | the strings `network` and `address` of `net.Listen`                                                                                                            | `net.Listener` ([net.go, about lines 398-408](https://github.com/golang/go/blob/go1.24.0/src/net/net.go))                                                                                    | `Listener.Addr()`              |
| Go x/net nettest | `NewLocalListener(network)`: "a loopback IP address or local file system path" ([docs](https://pkg.go.dev/golang.org/x/net/nettest#NewLocalListener))          | `net.Listener`                                                                                                                                                                               | `Listener.Addr()`              |
| Go httptest      | `newLocalListener`: `127.0.0.1:0`, then `[::1]:0` ([server.go, about lines 61-76](https://github.com/golang/go/blob/go1.24.0/src/net/http/httptest/server.go)) | `httptest.Server.Listener`                                                                                                                                                                   | `Server.URL`                   |
| Node.js          | the arguments of `server.listen(port, host)` or `server.listen(path)`                                                                                          | `net.Server` ([docs](https://nodejs.org/api/net.html#serverlisten))                                                                                                                          | `server.address()`             |
| `@zukhruf/pipes` | `PipeEndpoint`                                                                                                                                                 | `PipeEndpoint#listen(connectionListener)` gives a `PipeServer`                                                                                                                               | `PipeServer.endpoint.address`  |

Each listener of the table leaves an accepted connection open at its close.

## Decision

1. `Endpoint<A>` is an interface with one method: `listen(handler)` resolves with a `Listener<A>` when it listens. `handler` gets each accepted `net.Socket`. This is a Strategy (GoF): the server takes an endpoint and does not know which kind it is.
2. `Listener<A>` has `address` (of type `A`), `close()` and `[Symbol.asyncDispose]()`. Its close stops it accepting. It never ends a socket that it accepted, as Go's `net.Listener` and Node's `net.Server` do not. Only a `Server` ends them ([ADR 0004](./0004-a-server-is-a-value-and-serve-gives-a-serving-that-owns-each-socket-that-it-accepted.md)).
3. `new TcpEndpoint({ host = '127.0.0.1', port = 0 })` is the endpoint for TCP, over `net.Server.listen(port, host)`. Port 0 is a free port that the system chooses. Its listener's `address` is a `net.SocketAddress` with the port that it got, so no caller reads `server.address()` and no `portOf` is needed.
4. `PipeEndpoint` of `@zukhruf/pipes` is the endpoint for a Unix socket and a Windows named pipe. Its `listen(connectionListener)` already has the shape of `Endpoint`. Its address is a `PipeAddress`, because `net.SocketAddress` holds only an IP address and a port ([docs](https://nodejs.org/api/net.html#class-netsocketaddress)).
5. Thus `A` is the type of the address of the endpoint: `net.SocketAddress` for `TcpEndpoint`, `PipeAddress` for `PipeEndpoint`. The type of `serving.address` follows the endpoint, and a pipe never has a port.
6. `@zukhruf/net` does not import `@zukhruf/pipes`. `PipeEndpoint` meets `Endpoint<PipeAddress>` by its shape, and a type test of this package proves it.

## Considered Options

- **`Server.listen(handler)` and `Server.listen(endpoint, handler)`, statics after `httptest.NewServer`.** The step 2 draft had them. Ezz refused statics on 2026-11-28: "Go has no constructors, TS does" ([ADR 0004](./0004-a-server-is-a-value-and-serve-gives-a-serving-that-owns-each-socket-that-it-accepted.md)).
- **Strings, as Go's `net.Listen("tcp", "127.0.0.1:0")`.** A string is parsed at run time, and a wrong one fails then. A class is checked by the compiler.
- **A fallback to `[::1]` when `127.0.0.1` fails, as httptest and nettest do.** The default host is a ruling of Ezz, and no machine of the repositories has no IPv4 loopback. A caller gives `host: '::1'`.
- **`serving.address` of type `net.SocketAddress` for each endpoint, as the record of 2026-11-28 says.** A `net.SocketAddress` refuses anything but an IP address (`new net.SocketAddress({ address: 'localhost' })` throws `ERR_INVALID_ADDRESS`, Node 26.13.1), so it cannot hold the path of a pipe.
- **An address type of this package for both kinds.** `PipeAddress` already exists and connects; a second type would copy it.

## Consequences

- `PipeServer` has no `address` today: it has `endpoint.address`. Go's `Listener` has `Addr()`. The proposal is that pipes adds `readonly address: PipeAddress` to `PipeServer`, as a change of pipes in its own commit. This is a gap of pipes, named here as the user's rules ask, and it waits for Ezz's ruling.
- `PipeServer` has `unref()`. `Listener` does not ask for it, because no test needs it. The shipped servers of mutex and single-flight need it when they move ([ADR 0007](./0007-the-tests-move-first-and-each-shipped-server-moves-when-close-or-shutdown-is-its-kind-of-end.md)).
- A host can write its own endpoint, for example a TLS endpoint, with no change to this package.

## Confirmation

- Probe of 2026-11-28 on Node.js 26.13.1: `net.SocketAddress` exists; `new net.SocketAddress({ address: 'localhost', port: 1 })` throws `ERR_INVALID_ADDRESS`; `server.address()` after `listen(0, '127.0.0.1')` gives `{ address: '127.0.0.1', family: 'IPv4', port: <free port> }`.
- `packages/pipes/src/pipe-endpoint.ts`: `listen(connectionListener: (socket: Socket) => void): Promise<PipeServer>`.
