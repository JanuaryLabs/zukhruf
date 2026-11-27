# A base package above pipes owns the connections that a server accepts, and testing's HttpServer converges into it

Status: Proposed 2026-11-28 (backlog #6078).

Decision-makers: Ezz, on 2026-11-27, on two splits. On the home, the record says: "HOME: a BASE package owns the connections, for shipped code and tests (Ezz chose it over a test tool package ...). The faults ... go in a separate TOOL package on top of it." On HttpServer: "HttpServer of @zukhruf/testing/http CONVERGES into the base server package as its HTTP view". The zukhruf session of backlog #6078 decided the rest from the leaders (step 1 verdict, 2026-11-27): a new package above `@zukhruf/pipes`, and pipes does not converge into it.

A test often needs a server of its own: it listens on a free port of the loopback address, it gives its port, and at its end it ends each connection that it accepted and waits for the close. A sweep of the test files of 9 repositories on 2026-11-27 found this server in 48 test files (zukhruf 24, theagentlab 6, text2sql 5, context-compiler 4, agent-plugin 3, deepagents 2, elt 2, klp-web 1, april 1). Each copy has the same skeleton, line for line: `createServer`, a `Set` of sockets, `listen(0, '127.0.0.1')`, `once(server, 'listening')`, `address().port`, a `destroy()` of each socket, `close()`, `once(server, 'close')`. The function `portOf` that reads the port back has 13 copies (ssh 10, docker, testing, tools/eslint-rules).

Shipped code does the same work. 5 shipped files end the sockets that they accepted: ssh `control-master.ts:52-57` (destroy) and `shared-connection.ts:303+` (drain), and on a `PipeServer`, mutex `lock-server.ts:177-185` (destroy), election `leader-pipe.ts:65-69` (destroy) and single-flight `flight-server.ts:93-97` (`destroySoon`).

`@zukhruf/testing/http` `HttpServer` does this work for HTTP only, with 106 importing files in 8 repositories. docker's `src/testing/fake-engine.ts` does it for HTTP on a Unix socket, for 12 docker test files.

## The leaders

The leaders split two things. A listener accepts connections and never ends one that it accepted. A server keeps the connections that it accepted, and ends them at its close.

| Leader             | Listener: its close leaves the accepted connections open                                                                                                                                                         | Server: its close ends the accepted connections                                                                                                                                                                                                                                                     |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go                 | `net.Listener.Close`: "Close closes the listener. Any blocked Accept operations will be unblocked and return errors." ([net.go, about lines 398-408](https://github.com/golang/go/blob/go1.24.0/src/net/net.go)) | `http.Server.Close`: "Close immediately closes all active net.Listeners and any connections in state StateNew, StateActive, or StateIdle." ([pkg.go.dev](https://pkg.go.dev/net/http#Server.Close))                                                                                                 |
| Go httptest        | `httptest.Server.Listener`                                                                                                                                                                                       | `httptest.Server.Close` closes the idle and new connections and blocks until the requests have completed ([server.go, about lines 204-237](https://github.com/golang/go/blob/go1.24.0/src/net/http/httptest/server.go))                                                                             |
| .NET Kestrel 9.0.0 | `IConnectionListener.UnbindAsync` ([docs](https://learn.microsoft.com/dotnet/api/microsoft.aspnetcore.connections.iconnectionlistener))                                                                          | `TransportManager.StopTransportsAsync` calls `CloseAllConnectionsAsync`, and `AbortAllConnectionsAsync` when not all closed ([TransportManager.cs, about lines 120-154](https://github.com/dotnet/aspnetcore/blob/v9.0.0/src/Servers/Kestrel/Core/src/Internal/Infrastructure/TransportManager.cs)) |
| Node.js 26         | `net.Server.close()`: "Stops the server from accepting new connections and keeps existing connections" ([docs](https://nodejs.org/api/net.html#serverclosecallback))                                             | `http.Server.closeAllConnections()` ([docs](https://nodejs.org/api/http.html#servercloseallconnections)); `net.Server` has no such method (probe of 2026-11-28 on 26.13.1)                                                                                                                          |
| `@zukhruf/pipes`   | `PipeServer.close()` leaves the open connections open ([pipes ADR 0007](../../../pipes/docs/adr/0007-the-endpoint-listens-the-address-connects-and-the-server-owns-its-file.md))                                 | none                                                                                                                                                                                                                                                                                                |
| Toxiproxy          | none                                                                                                                                                                                                             | each proxy keeps the list of its connections and closes them ([README](https://github.com/Shopify/toxiproxy#toxics))                                                                                                                                                                                |

## Decision

1. A new package of the base layer (`std:base`, `layer:island`) owns the connections that a server accepts. Its name is `@zukhruf/net` ([ADR 0002](./0002-the-name-is-net-after-go-net-and-node-net.md)).
2. The package is above `@zukhruf/pipes`, as `http.Server` of Go is above `net.Listener`. A `PipeEndpoint` is one of its endpoints ([ADR 0003](./0003-an-endpoint-listens-and-gives-a-listener-that-never-ends-an-accepted-socket.md)). The package imports no other zukhruf package at run time. Thus the shipped code and the tests of `async`, `docker`, `fs`, `ssh`, `mutex`, `single-flight` and `election` can use it.
3. `@zukhruf/pipes` does not converge into it. Its `PipeServer` is a listener, and it stays one: mutex destroys its connections and single-flight ends each one after the flush, which are two kinds of end (pipes ADR 0007).
4. `HttpServer` of `@zukhruf/testing/http` moves into the subpath `@zukhruf/net/http`, with no alias ([ADR 0006](./0006-the-http-view-is-a-server-whose-handler-gives-each-socket-to-an-http-server.md)). The area `./http` of `@zukhruf/testing` goes away.
5. docker's `fakeEngine`, ssh's `startSilentServer`, the `standInServer` copies of mutex and single-flight, the `listen` helpers of ssh's `control.test.ts` and `owner-death.test.ts`, and the 13 copies of `portOf` move to this package ([ADR 0007](./0007-the-tests-move-first-and-each-shipped-server-moves-when-close-or-shutdown-is-its-kind-of-end.md)).
6. The faults (latency, partition, reset, stall) are not in this package. They are in the tool package `@zukhruf/chaos`, on top of it.

## Considered Options

- **A tool package for tests only.** The evidence then was 2 shipped files against 48 test files. Ezz chose a base package, because shipped code ends accepted sockets too; the count is 5 shipped files now. A tool package also cannot be imported by the tests of `docker`, `fs` and `ssh` when it depends on them (root ADR 0001).
- **Grow `@zukhruf/pipes` to own the connections.** A listener that ends its connections is not a listener of Go, .NET or Node. pipes ADR 0007 refused it: its two consumers end connections in two ways.
- **Pipes converges into the new package.** Pipes owns the socket file and its rules (the folder of the user, the path length, the Windows pipe name). That knowledge does not change for a reason of the connections.
- **An area of `@zukhruf/testing`.** It is a tool package, so shipped code cannot import it.
- **A new base package above pipes.** This option was selected.

## Consequences

- The base row of root ADR 0001 gets `net`. The tool row keeps `testing`, without its `./http` export.
- Testing ADRs 0028 and 0030 move with `HttpServer` as decisions of the HTTP view. Testing ADR 0005 stays superseded.
- Each consumer moves after the release of the package ([ADR 0007](./0007-the-tests-move-first-and-each-shipped-server-moves-when-close-or-shutdown-is-its-kind-of-end.md)), and each copy and its ledger row go.
- Backlog #5655 (`TcpHop` in `@zukhruf/testing`) and #5947 (`portOf`) close with #6078.

## Confirmation

- The sweep of 2026-11-27 (backlog #6078): regex detectors over the test files that `git ls-files` lists, spot check 5 of 5.
- The count of shipped servers and of `HttpServer` importers of 2026-11-28 (session f0478ea1), kept in `~/.claude/plans/test-primitives-6078/map.txt` and `httpserver-importers.txt`.
- The leaders' sources, read on 2026-11-27 and again on 2026-11-28, as linked in the table.
