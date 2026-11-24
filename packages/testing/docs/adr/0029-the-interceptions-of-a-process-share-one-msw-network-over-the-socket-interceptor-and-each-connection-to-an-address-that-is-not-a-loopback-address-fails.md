# The interceptions of a process share one msw network over the socket interceptor, and each connection to an address that is not a loopback address fails

Status: Accepted 2026-11-24 (Ezz, "Own network + block"; backlog #4881, #5492). The `requests` of two interceptions that are open at the same time is Accepted 2026-11-24 (Ezz, "Every open one records all"; see Consequences).

An interception was an msw `setupServer` with `listen({ onUnhandledFrame: 'error' })` ([ADR 0010](./0010-the-msw-area-is-always-strict-and-records-each-request.md)). It promised to fail each request that no handler answers. On msw 3.0.7 and `@mswjs/interceptors` 0.45.12, measured on Node 26.13.0 on 2026-11-24, requests reached the network in these cases:

- `setupServer` uses `ClientRequestInterceptor`, `XMLHttpRequestInterceptor` and `FetchInterceptor`. A request of npm undici 7.30.2 (`undici.request`) and an HTTP request on a raw `node:net` socket do not go through them. They reached the real host, also with a handler for the URL, and `requests` did not record them (#4881).
- A raw socket that reads first, and a request that the interceptor cannot parse, pass through to the real host (#4881).
- A `fetch` that starts in the same turn as the disposal passes through (upstream `@mswjs/interceptors` #880).
- `setupServer` keeps its interceptors and its network source at module level (`msw/lib/node/index.js`, `defaultInterceptors`, `defaultNetworkOptions`). Each `listen()` takes the source from the server before it, so only the newest open interception asks its handlers. Each `close()` disposes the interceptors of every server, so the other open interceptions stop: their requests reach the network (#5492; upstream msw #1283).

deepagents met the first case in #3467: a test made 34 real TLS connections to `api.anthropic.com`.

## Decision

Ezz chose "Own network + block" in chat on 2026-11-24. Two parts make each interception strict again:

1. **One msw network for the process, over the socket interceptor.** The first interception builds an msw network with `defineNetwork` of `msw/experimental`. Its source is an `InterceptorSource` over a new `HttpRequestInterceptor` of `@mswjs/interceptors/http` and the shared `WebSocketInterceptor` (`Interceptor.singleton`: a second instance fails with "Failed to replace a global value at "WebSocket": already replaced"). `HttpRequestInterceptor` patches `node:net`, so it sees `fetch`, `http.request`, undici and a raw socket. The network asks the handlers of each open interception, the newest interception first, and then fails the request with the `error` strategy. The network listens while one interception or more is open. The decision named a network for each interception. Two strict networks on one socket interceptor each fail what only the other handles: the first test of #5492 for two open interceptions failed with the msw error. Thus the interceptions share the one network, and each interception owns its handlers.
2. **A guard on each new socket.** The first interception subscribes to the `net.client.socket` channel of `node:diagnostics_channel`, for the life of the process. The subscriber sets `socket.blockList` to a `net.BlockList` of each address that is not a loopback address: IPv4 outside `127.0.0.0/8`, and IPv6 `2000::/3` and `fc00::/7`. (`::/0` also holds each IPv4 address.) Node then fails the connection with `ERR_IP_BLOCKED` before it calls `connect` (`lib/net.js`, `internalConnect`), so no byte leaves. The interception records each refused `address:port` from the `connectionAttempt` and `connectionAttemptFailed` events of the socket, and `cleanup()` rejects with `NetConnectNotAllowedError` (code `ENETUNREACH`, message `Disallowed net connect for "<address>:<port>"`), after it closed the interception. nock 15 has the same class, code and message (`lib/handle-request.js`).

`server` is the handlers and the events of the interception: `use`, `resetHandlers`, `restoreHandlers`, `listHandlers` and `events` of an msw network (type `MswServer`). It is no longer a `SetupServer`.

## Considered Options

- **A network for each interception, with no guard.** It fixes undici and raw sockets. A read-first socket, a parse error and a request in the same turn as the disposal still pass through.
- **The guard only.** It stops each connection to a real host. undici and raw sockets still skip the handlers, so a mock for them does not answer, and `requests` does not record them. #5492 stays.
- **An undici dispatcher with a lookup that always fails, as deepagents did for #3467.** It covers only `fetch` and undici, not `http.request` or a raw socket. It also needs the private `Symbol.for('undici.globalDispatcher.1')`.
- **`socket.destroy(err)` in the `net.client.socket` subscriber.** Measured: `fetch` and `net.connect` still connect.
- **A `connectionAttempt` listener that destroys the socket.** Node 26.13.0 then fails with a `TypeError` in `internalConnect` (`node:net:1449`).
- **A block of loopback addresses too.** The mock lookup of msw returns `127.0.0.1`, so each mock would fail.

## Consequences

- msw `^3.0.7` and `@mswjs/interceptors` `^0.45.12` are optional peer dependencies and development dependencies. `msw/experimental` is an experimental API of msw.
- From the first interception on, each connection of the process to an address that is not a loopback address fails, also after the disposal. A test that needs a real host runs in another process. node:test runs each test file in its own process. A mock for a URL with a public IP address as its host fails too. Loopback connections stay allowed, so a passthrough to a local server works. A test process of a run reaches an SSH engine through a Unix socket and a loopback forward ([ADR 0024](./0024-a-run-holds-one-ssh-connection-to-an-ssh-engine-and-its-test-processes-reach-the-engine-host-through-it.md)). A `DockerTestbed` outside a run opens its own SSH connection to the engine host, and that connection fails when an interception started before it in the same process.
- Node documents `blockList` only as an option of `new net.Socket()` and `net.connect()`. The guard sets the property after the constructor, as the constructor does.
- `HttpRequestInterceptor` also sees connections that are not HTTP, such as a database client. It passes them through, as the TCP and TLS tests of [ADR 0028](./0028-an-interceptions-disposal-waits-until-the-client-has-closed-each-connection-that-the-server-closed.md) show.
- A refused connection that starts in the same turn as the disposal fails, but the disposal does not name it: the interception is closed when the connection starts.
- Accepted 2026-11-24 (Ezz, "Every open one records all"): each open interception records each request of the process in `requests`, in the order of arrival, and gets each event of the network in `server.events`. Before this record, only the newest open interception recorded a request. With one open interception, nothing changes.
