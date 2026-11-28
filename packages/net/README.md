# @zukhruf/net

> **In build (backlog #6078).** The API on paper was approved on 2026-11-28, and there is no code yet. Each decision is an accepted ADR, and each detail that the review decided is in [Decided in the review](#decided-in-the-review).

A server of this program that accepts connections, and that ends each one at its end. A `Server` says what to do with each connection. `server.serve(endpoint)` listens on a TCP port of the loopback address or on a pipe, and gives a `Serving`. The serving keeps each socket that it accepted. Its `close()` destroys each one and waits for its close, and its `shutdown(signal)` waits until each one ends by itself and closes the rest at the abort. `@zukhruf/net/http` is the same server for HTTP.

A test needs this server most: 48 test files of 9 repositories have their own copy of it, and 13 files have their own `portOf` ([ADR 0001](./docs/adr/0001-a-base-package-above-pipes-owns-the-connections-that-a-server-accepts-and-testings-httpserver-converges-into-it.md)). It is a base package, so shipped code can use it too.

The words in these documents have one meaning each. See the glossary in [CONTEXT.md](./CONTEXT.md).

## Use it

```sh
npm install @zukhruf/net
```

```ts
import { Server, TcpEndpoint } from '@zukhruf/net';

const echo = new Server((socket) => socket.pipe(socket));
await using serving = await echo.serve(new TcpEndpoint());
console.log(serving.address.port); // a free port of 127.0.0.1
```

## Listen on a free port

`new TcpEndpoint({ host, port })` says where to listen. The defaults are `host: '127.0.0.1'` and `port: 0`, a free port that the system chooses. `serving.address` is a `net.SocketAddress` with the port that the serving got ([ADR 0003](./docs/adr/0003-an-endpoint-listens-and-gives-a-listener-that-never-ends-an-accepted-socket.md)).

```ts
await using serving = await server.serve(new TcpEndpoint());
const client = connect(serving.address.port, serving.address.address);
```

- `host` is an IP address. The endpoint does not look up a host name.
- To listen again on the same port, give it: `server.serve(new TcpEndpoint({ port: serving.address.port }))`.

## Listen on a pipe

A `PipeEndpoint` of `@zukhruf/pipes` is an endpoint too: a Unix socket on macOS and Linux, a named pipe on Windows. `serving.address` is then its `PipeAddress`, and it has no port.

```ts
import { Server } from '@zukhruf/net';
import { PipeEndpoint } from '@zukhruf/pipes';

await using serving = await new Server(onPeer).serve(
  new PipeEndpoint(socketPath, { prefix: 'mutex' }),
);
const peer = await serving.address.connect();
```

## Say what to do with each connection

`new Server(handler, options)` holds the handler and listens on nothing. `handler(socket)` gets each accepted `net.Socket`. A server can serve more than once, also on two endpoints at once ([ADR 0004](./docs/adr/0004-a-server-is-a-value-and-serve-gives-a-serving-that-owns-each-socket-that-it-accepted.md)).

| Copy today                                      | With the package                                               |
| ----------------------------------------------- | -------------------------------------------------------------- |
| ssh `startSilentServer()`                       | `new Server(() => {}).serve(new TcpEndpoint())`                |
| mutex `standInServer(path, onPeer)`             | `new Server(onPeer).serve(new PipeEndpoint(path, { prefix }))` |
| ssh `listen(path, accepted, { allowHalfOpen })` | `new Server(accepted, { allowHalfOpen }).serve(endpoint)`      |
| `portOf(server)`                                | `serving.address.port`                                         |

## End a serving

| Call                               | What happens underneath                                                                                                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `await serving.close()`            | The listener stops its accepts. Each accepted socket gets `destroy()`. It resolves when the listener has closed and each socket has emitted `close`.                    |
| `await using serving = ...`        | `close()` at the end of the scope.                                                                                                                                      |
| `await serving.shutdown(signal)`   | The listener stops its accepts. It waits until each accepted socket has closed by itself. When `signal` aborts first, it destroys the rest and waits for their `close`. |
| a second `close()` or `shutdown()` | It waits for the end of the first call and resolves.                                                                                                                    |

The listener's own close never ends an accepted socket, as Go's `net.Listener` does not. Only the serving ends them ([ADR 0005](./docs/adr/0005-close-ends-each-accepted-socket-and-waits-for-its-close-and-shutdown-waits-for-the-sockets-until-its-signal-aborts.md)).

## Serve HTTP

`new HttpServer(handler, options)` of `@zukhruf/net/http` is a server whose handler gives each accepted socket to its own `http.Server`. `handler` is a request listener of `node:http`. On a TCP endpoint, the serving has `origin` ([ADR 0006](./docs/adr/0006-the-http-view-is-a-server-whose-handler-gives-each-socket-to-an-http-server.md)).

```ts
import { TcpEndpoint } from '@zukhruf/net';
import { HttpServer } from '@zukhruf/net/http';

await using site = await new HttpServer((request, response) => {
  response.end('hello');
}).serve(new TcpEndpoint());
const answer = await fetch(`${site.origin}/`);
```

- The close destroys each accepted socket, also a socket that an `upgrade` took. Then it destroys each client socket of this process that belonged to a destroyed connection, and waits for its `close`, so the timers of `fetch` are cleared before the next test (testing ADR 0030).
- `shutdown(signal)` ends each idle connection at once, and each other connection after its response, as Go's `Shutdown`.
- `options` are those of `http.createServer` (`keepAliveTimeout`, `highWaterMark`, ...) and `upgrade`, a listener of the `upgrade` event. docker's fake engine needs all three.

| `@zukhruf/testing/http` today                | `@zukhruf/net/http`                                        |
| -------------------------------------------- | ---------------------------------------------------------- |
| `await new HttpServer().start(handler)`      | `await new HttpServer(handler).serve(new TcpEndpoint())`   |
| `handle.origin`                              | `serving.origin`                                           |
| `await handle.cleanup()`                     | `await serving.close()`                                    |
| `handle.server.close()`, then `listen(port)` | `serving.close()`, then `serve(new TcpEndpoint({ port }))` |
| `HttpServerHandle`                           | `HttpServing`                                              |

## Errors

The package has no error class of its own. A caller does not do a different next step for an error of this package.

| Error                            | When                                                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| the error of `net.Server.listen` | `serve()` rejects with it: `EADDRINUSE` for a port in use, `EACCES`, `EADDRNOTAVAIL`.                 |
| the errors of `@zukhruf/pipes`   | `serve()` on a `PipeEndpoint` rejects with them: `UnsafeFolderError`, a `RangeError` for a long path. |

## What the package does not do

- **Faults.** Latency, a partition, a reset or a stall are in the tool package `@zukhruf/chaos`, which uses this one.
- **Look up a host name.** `TcpEndpoint` takes an IP address, as `net.SocketAddress` does.
- **Tell a raw handler that a shutdown began.** Kestrel does it with `ConnectionClosedRequested`. It is on the map as later.
- **TLS.** A host can write a TLS endpoint: an `Endpoint` is an interface.
- **Later, on the map:** `unref()` and the five shipped servers (mutex, election, single-flight, ssh twice), testing's `EngineProxy` ([ADR 0007](./docs/adr/0007-the-tests-move-first-and-each-shipped-server-moves-when-close-or-shutdown-is-its-kind-of-end.md)).

## Who uses it

| Consumer                                                                                                                                 | How                                                  | Record        |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ------------- |
| 106 test files of elt (49), text2sql (20), sdk-it (18), finetuning (9), mteb (6), deepagents (2), context-compiler (1), offers-evals (1) | `HttpServer`, today from `@zukhruf/testing/http`     | backlog #6078 |
| docker's 12 test files of the engine                                                                                                     | `HttpServer` on a `PipeEndpoint`, today `fakeEngine` | backlog #6078 |
| ssh's `client`, `config-dial-route` and `config-dial` tests                                                                              | `Server` with no handler, today `startSilentServer`  | backlog #6078 |
| 6 mutex and 3 single-flight test files                                                                                                   | `Server` on a `PipeEndpoint`, today `standInServer`  | backlog #6078 |
| ssh `control.test.ts`, `owner-death.test.ts`                                                                                             | `Server` with `allowHalfOpen`, today `listen`        | backlog #6078 |
| 13 files of docker, ssh, testing and tools/eslint-rules                                                                                  | `serving.address.port`, today `portOf`               | backlog #5947 |
| `@zukhruf/chaos`                                                                                                                         | `Proxy` is a handler that a `Server` serves          | backlog #6078 |

## The same concepts in other systems

| Concept                                | Other systems                                                                                                                                                                                                                                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An endpoint                            | .NET `EndPoint`, `IPEndPoint`, `UnixDomainSocketEndPoint`; Go x/net [`nettest.NewLocalListener`](https://pkg.go.dev/golang.org/x/net/nettest#NewLocalListener)                                                                                                                 |
| A listener that leaves its connections | Go [`net.Listener`](https://pkg.go.dev/net#Listener), .NET `IConnectionListener`, Node.js [`net.Server.close`](https://nodejs.org/api/net.html#serverclosecallback), `@zukhruf/pipes` `PipeServer`                                                                             |
| A close that ends the connections      | Go [`http.Server.Close`](https://pkg.go.dev/net/http#Server.Close), [`httptest.Server.Close`](https://pkg.go.dev/net/http/httptest#Server.Close), Kestrel `AbortAllConnectionsAsync`                                                                                           |
| A shutdown with a limit                | Go [`http.Server.Shutdown(ctx)`](https://pkg.go.dev/net/http#Server.Shutdown), Kestrel [`CloseAllConnectionsAsync` then `AbortAllConnectionsAsync`](https://github.com/dotnet/aspnetcore/blob/v9.0.0/src/Servers/Kestrel/Core/src/Internal/Infrastructure/TransportManager.cs) |
| HTTP over a listener                   | Go [`http.Server.Serve(l)`](https://pkg.go.dev/net/http#Server.Serve), Node.js [`emit('connection')`](https://nodejs.org/api/http.html#event-connection)                                                                                                                       |
| The origin of a test server            | Go httptest [`Server.URL`](https://pkg.go.dev/net/http/httptest#Server)                                                                                                                                                                                                        |

## Why not a package of npm

The leaders' standard libraries split listener and server, and Node.js 26 gives every part but the tracking of accepted sockets on a `net.Server`: `net.Server` has no `closeAllConnections` (probe of 2026-11-28). The package adds that one part. No npm package does that part (probe of 2026-11-28 on Node.js 26). `stoppable` 1.1.0 (last release 2018) ends and destroys the sockets of a raw `net.Server`, but its grace is a fixed time with no abort signal, and with sockets that `emit('connection')` gave an `http.Server` it calls back before their close. `http-terminator` 3.2.0 (last release 2022) skips the sockets of a raw `net.Server` and polls every 10 ms. Both lean on `server.close()`, so neither waits for sockets that the server did not accept itself.

## API

```ts
import type {
  IncomingMessage,
  ServerOptions as NodeHttpServerOptions,
  ServerResponse,
} from 'node:http';
import type { Socket, SocketAddress } from 'node:net';
import type { Duplex } from 'node:stream';

/** Gets each accepted socket. */
export type Handler = (socket: Socket) => void;

/** Accepts connections and gives each one to a handler. Its close leaves each accepted socket open. Go's net.Listener. */
export interface Listener<A> extends AsyncDisposable {
  readonly address: A;
  close(): Promise<void>;
}

/** Where a server listens. PipeEndpoint of @zukhruf/pipes is one. */
export interface Endpoint<A> {
  listen(handler: Handler): Promise<Listener<A>>;
}

export interface TcpEndpointOptions {
  /** An IP address. Default '127.0.0.1'. */
  readonly host?: string;
  /** Default 0: a free port that the system chooses. */
  readonly port?: number;
}

export class TcpEndpoint implements Endpoint<SocketAddress> {
  constructor(options?: TcpEndpointOptions);
  listen(handler: Handler): Promise<Listener<SocketAddress>>;
}

export interface ServerOptions {
  /** Set on each accepted socket before the handler gets it. Default false, as node:net. */
  readonly allowHalfOpen?: boolean;
}

/** What to do with each connection. It listens on nothing until serve(). */
export class Server {
  constructor(handler: Handler, options?: ServerOptions);
  serve<A>(endpoint: Endpoint<A>): Promise<Serving<A>>;
}

/** A server while it listens on one endpoint. Only serve() makes one. */
export interface Serving<A> extends AsyncDisposable {
  readonly address: A;
  /** The accepted sockets that are open now. */
  readonly connections: number;
  /** Stops the accepts, destroys each accepted socket, waits for each close. */
  close(): Promise<void>;
  /** Stops the accepts, waits until each accepted socket has closed; at the abort of signal, closes the rest. */
  shutdown(signal: AbortSignal): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
}
```

```ts
// @zukhruf/net/http
/** A request listener of node:http. A rejection stays unhandled and fails the process. */
export type HttpHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => unknown;

export interface HttpServerOptions extends NodeHttpServerOptions {
  /** A listener of the upgrade event. The serving destroys its socket at the close. */
  readonly upgrade?: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => void;
}

export class HttpServer {
  constructor(handler: HttpHandler, options?: HttpServerOptions);
  serve(endpoint: Endpoint<SocketAddress>): Promise<HttpServing<SocketAddress>>;
  serve<A>(endpoint: Endpoint<A>): Promise<HttpServing<A>>;
}

/** An HTTP serving. Only an endpoint with a SocketAddress gives it an origin. */
export type HttpServing<A> = Serving<A> &
  (A extends SocketAddress ? { readonly origin: string } : unknown);
```

## Decided in the review

Each item is a detail that a caller sees. Ezz approved each proposal on 2026-11-28 ("Approve as written"; item 2, `address` on `PipeServer`: "Add address"), and each follows the leader that it names. The npm candidates are probed before the build.

1. **The type of `serving.address`.** The record says `net.SocketAddress`. It cannot hold a pipe's path. Proposal: `Endpoint<A>` and `Serving<A>`, so the address is a `net.SocketAddress` for TCP and a `PipeAddress` for a pipe (.NET's `IConnectionListener.EndPoint`, typed by the endpoint) ([ADR 0003](./docs/adr/0003-an-endpoint-listens-and-gives-a-listener-that-never-ends-an-accepted-socket.md)).
2. **`address` on `PipeServer`.** Ezz: "Add address". `PipeServer.address` is the address of its endpoint, after Go's `Listener.Addr()`, since 663e84b0, so a `PipeEndpoint` meets `Endpoint`.
3. **`allowHalfOpen` is an option of `Server`, not of `TcpEndpoint`.** `Endpoint#listen(handler)` takes no options, so the serving sets `socket.allowHalfOpen = true` on each accepted socket before the handler (probe of 2026-11-28: a server that sets it after the accept answers after the client's end). Node.js has it as an option of `net.createServer`. ssh's `listen` and testing's `slowProxy` use it.
4. **The serving ignores the `error` event of each accepted socket.** Each copy adds `socket.on('error', () => {})`, because a reset of the peer is normal in a test and an `error` with no listener ends the process. The handler still sees each error in its reads and writes, as a Go `Read` and `Write` return it. Proposal: yes.
5. **`serving.connections`.** docker's `fakeEngine` has `openConnections`, and `slowProxy` has `connections()`, which 3 database tests of testing read. Proposal: `connections`, the accepted sockets that are open now. Go httptest and Kestrel expose no count; Toxiproxy lists the connections of a proxy.
6. **docker's `allConnectionsClosed`.** It waits until each connection has closed, and the engine still listens. Proposal: no member; those tests call `shutdown(t.signal)`, which waits for the same thing and stops the accepts.
7. **What `shutdown(signal)` gives after an abort.** Go's `Shutdown` returns the error of the context. Proposal: it closes the rest, then rejects with `signal.reason`, so a caller knows that the end was not graceful; this is also how `Command#run` of `@zukhruf/process` rejects at the abort of its signal.
8. **No fallback to `[::1]`.** httptest and nettest try `[::1]:0` when `127.0.0.1:0` fails. Proposal: no fallback; the default host is a ruling, and a caller gives `host: '::1'`.
9. **The type of `Handler`.** Proposal: `(socket: Socket) => void`, as the `connectionListener` of `net.createServer` and of `PipeEndpoint#listen`.
10. **`origin` only on TCP.** Proposal: `HttpServing<A>` has `origin` only when `A` is a `net.SocketAddress`, so a serving on a pipe has no URL to misuse (httptest's `URL`).
11. **`HttpServer` options.** Proposal: the options of `http.createServer` and `upgrade`. Go's `http.Server` has its fields; Node's `http.createServer(options)` has these.
12. **The call of the 106 importers changes.** The record of 2026-11-27 says "change one import, no alias"; the composable shape of 2026-11-28 changes the call too (see the table in [Serve HTTP](#serve-http)). Proposal: the later ruling, with no `start()` kept.
13. **npm candidates.** Probed on 2026-11-28: `stoppable` and `http-terminator` do part of the job and fail at the rest (see [Why not a package of npm](#why-not-a-package-of-npm) above), so the package tracks its sockets itself.

## Documentation

**Decisions**

- [ADR 0001](./docs/adr/0001-a-base-package-above-pipes-owns-the-connections-that-a-server-accepts-and-testings-httpserver-converges-into-it.md): a base package above pipes owns the connections that a server accepts, and testing's HttpServer converges into it.
- [ADR 0002](./docs/adr/0002-the-name-is-net-after-go-net-and-node-net.md): the name is net, after Go net and Node net.
- [ADR 0003](./docs/adr/0003-an-endpoint-listens-and-gives-a-listener-that-never-ends-an-accepted-socket.md): an endpoint listens and gives a listener that never ends an accepted socket.
- [ADR 0004](./docs/adr/0004-a-server-is-a-value-and-serve-gives-a-serving-that-owns-each-socket-that-it-accepted.md): a server is a value, and serve gives a serving that owns each socket that it accepted.
- [ADR 0005](./docs/adr/0005-close-ends-each-accepted-socket-and-waits-for-its-close-and-shutdown-waits-for-the-sockets-until-its-signal-aborts.md): close ends each accepted socket and waits for its close, and shutdown waits for the sockets until its signal aborts.
- [ADR 0006](./docs/adr/0006-the-http-view-is-a-server-whose-handler-gives-each-socket-to-an-http-server.md): the HTTP view is a server whose handler gives each socket to an http.Server.
- [ADR 0007](./docs/adr/0007-the-tests-move-first-and-each-shipped-server-moves-when-close-or-shutdown-is-its-kind-of-end.md): the tests move first, and each shipped server moves when close or shutdown is its kind of end.
