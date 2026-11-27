# The name is net, after Go net and Node net

Status: Proposed 2026-11-28 (backlog #6078).

Decision-makers: Ezz, on 2026-11-28. The record says: "DECIDED (Ezz, 2026-11-28, step 2): the base package follows Go: @zukhruf/net (Go net and Node net; Go names for its types: Server, Close, Shutdown, Addr as address)". The step 2 draft had proposed `@zukhruf/connections`.

| Leader  | Module                                                                     | The types for this work                                                                                                                                                                                        |
| ------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go      | [`net`](https://pkg.go.dev/net), [`net/http`](https://pkg.go.dev/net/http) | `Listener` (`Accept`, `Close`, `Addr`), `http.Server` (`Close`, `Shutdown`)                                                                                                                                    |
| .NET    | `System.Net`, `Microsoft.AspNetCore.Connections`                           | `EndPoint`, `IPEndPoint`, `IConnectionListenerFactory.BindAsync(EndPoint)`, `IConnectionListener` ([docs](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.connections.iconnectionlistenerfactory)) |
| Node.js | [`node:net`](https://nodejs.org/api/net.html), `node:http`                 | `net.Server`, `net.Socket`, `net.SocketAddress`                                                                                                                                                                |

## Decision

- The package is `@zukhruf/net`, in `packages/net`. The word is the module of Go and of Node.js for sockets and listeners, a noun of one word, as `fs`, `process` and `ssh` are.
- The types take Go's names where Go has the concept: `Server`, `Listener`, `close()` for Go's `Close`, `shutdown(signal)` for Go's `Shutdown(ctx)`, and `address` for Go's `Addr()`.
- `Endpoint` and `TcpEndpoint` take .NET's word: Go has no type for where to listen, and gives a string to `net.Listen` ([ADR 0003](./0003-an-endpoint-listens-and-gives-a-listener-that-never-ends-an-accepted-socket.md)). `@zukhruf/pipes` already uses the word for `PipeEndpoint`.
- The HTTP view is the subpath `@zukhruf/net/http`, as Go's `net/http` is below `net`.
- A file that imports `node:net` and `@zukhruf/net` names one of them: `import * as net from 'node:net'` beside `import { Server } from '@zukhruf/net'`.

## Considered Options

- **`@zukhruf/connections`, after .NET's `Microsoft.AspNetCore.Connections`.** It names one part of the work, and Ezz chose Go's name.
- **`@zukhruf/sockets`.** No standard library of the leaders has a module of that name for listeners and servers.
- **`@zukhruf/net`.** This option was selected.

## Consequences

- The class `Server` of this package and `net.Server` of Node.js have the same name. A file that uses both imports Node's as `net.Server`.
